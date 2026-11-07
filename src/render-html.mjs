/**
 * 06 local diagrams — offline HTML artifact renderer (DIA-03/05).
 *
 * Frozen interface (docs/interfaces.md §5):
 *   renderHtml({spec, overlay, layout, svg, text_equivalent, legend, hidden,
 *               manifest, renderer_ref, source_state}) -> {html, script_hash}
 *   cspFor(script_hash) -> string
 *
 * The HTML is a self-contained offline document: no external resources, one
 * fixed inline script (pan/zoom/selection/certainty filter) and one fixed
 * inline style block, both referenced from the CSP by their sha256 hashes.
 * There is no fetch/WebSocket/eval/new Function/XHR, no remote URL, and every
 * dynamic string is XML/HTML-escaped. The SVG namespace declaration is emitted
 * through a numeric character reference by the SVG renderer, so generated
 * documents contain no http(s):// substring at all (this file's fixed strings
 * included).
 */
import { createHash } from 'node:crypto';
import { escXml, renderSvg } from './render-svg.mjs';
import { LIMITS } from './limits.mjs';

/**
 * Fixed inline script. It only reads/writes DOM attributes/classes; it never
 * evaluates dynamic code, opens connections, or builds markup from strings.
 */
export const INLINE_SCRIPT = `(() => {
  'use strict';
  var zoomLevels = ['1', '1.25', '1.5'];
  var zoomIndex = 0;
  function clearSelection() {
    var selected = document.querySelectorAll('[data-selected]');
    for (var i = 0; i < selected.length; i += 1) selected[i].removeAttribute('data-selected');
    var label = document.getElementById('ld-selection');
    if (label) label.textContent = '';
  }
  function selectEntity(entity) {
    clearSelection();
    entity.setAttribute('data-selected', 'true');
    var label = document.getElementById('ld-selection');
    if (!label) return;
    var id = entity.getAttribute('data-entity-id') || '';
    var kind = entity.getAttribute('data-kind') || '';
    label.textContent = id + (kind ? ' (' + kind + ')' : '');
  }
  document.addEventListener('click', function (event) {
    var target = event.target;
    while (target && target !== document.body) {
      if (target.getAttribute) {
        if (target.getAttribute('data-entity-id')) { selectEntity(target); return; }
        var filter = target.getAttribute('data-filter-certainty');
        if (filter) {
          if (document.body.getAttribute('data-dim') === filter) document.body.removeAttribute('data-dim');
          else document.body.setAttribute('data-dim', filter);
          return;
        }
      }
      target = target.parentNode;
    }
    clearSelection();
  });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') clearSelection();
    if (event.key === '+' || event.key === '=') {
      zoomIndex = Math.min(zoomLevels.length - 1, zoomIndex + 1);
      document.body.setAttribute('data-zoom', zoomLevels[zoomIndex]);
    }
    if (event.key === '-') {
      zoomIndex = Math.max(0, zoomIndex - 1);
      document.body.setAttribute('data-zoom', zoomLevels[zoomIndex]);
    }
  });
})();`;

/** Fixed inline stylesheet (no remote fonts/images; system fonts only). */
export const INLINE_STYLE = `:root{color-scheme:light}
*{box-sizing:border-box}
body{margin:0;padding:0 0 32px;background:#f8fafc;color:#111827;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;font-size:14px;line-height:1.5}
header.source-bar{padding:16px 24px;background:#ffffff;border-bottom:1px solid #e5e7eb}
header.source-bar h1{margin:0 0 8px;font-size:18px;font-weight:600;word-break:break-word}
header.source-bar dl{display:flex;flex-wrap:wrap;gap:6px 24px;margin:0}
header.source-bar dl div{display:flex;gap:6px;align-items:baseline}
header.source-bar dt{color:#6b7280;font-size:12px}
header.source-bar dd{margin:0;font-size:13px;word-break:break-all;max-width:420px}
main{padding:16px 24px;display:flex;flex-direction:column;gap:16px}
.viewport-wrap{overflow:auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;max-height:70vh;padding:8px}
#diagram-viewport{transition:transform 120ms ease-out;transform-origin:top left}
body[data-zoom="1.25"] #diagram-viewport{transform:scale(1.25)}
body[data-zoom="1.5"] #diagram-viewport{transform:scale(1.5)}
#ld-selection{min-height:20px;color:#374151;font-size:13px}
section.legend ul{display:flex;flex-wrap:wrap;gap:8px;list-style:none;margin:0;padding:0}
section.legend li{display:flex;align-items:center;gap:6px;padding:4px 10px;border:1px solid #d1d5db;border-radius:999px;background:#ffffff;cursor:pointer;user-select:none}
section.legend .swatch{width:18px;height:2px;display:inline-block;background:#1f2937}
section.legend li.certainty-may .swatch{background:#b45309;border-top:2px dashed #b45309;height:0}
section.legend li.certainty-unresolved .swatch{background:#b91c1c;border-top:2px dotted #b91c1c;height:0}
section.legend li.certainty-unknown .swatch{background:#6b7280;border-top:2px dashed #6b7280;height:0}
section.legend .count{font-variant-numeric:tabular-nums;color:#374151}
body[data-dim] .edge,body[data-dim] .node{opacity:0.35;transition:opacity 120ms ease-out}
body[data-dim="exact"] .edge.certainty-exact,body[data-dim="may"] .edge.certainty-may,body[data-dim="unresolved"] .edge.certainty-unresolved,body[data-dim="unknown"] .edge.certainty-unknown{opacity:1}
#diagram-viewport [data-selected="true"] rect{stroke-width:3}
#diagram-viewport [data-selected="true"] path{stroke-width:3}
ul.warnings{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px}
ul.warnings li{padding:6px 10px;border-radius:6px;background:#fffbeb;border:1px solid #fcd34d;color:#78350f;font-size:13px}
ul.warnings li.none{background:#ecfdf5;border-color:#6ee7b7;color:#065f46}
table.text-equivalent{width:100%;border-collapse:collapse;background:#ffffff;border:1px solid #e5e7eb}
table.text-equivalent caption{text-align:left;font-weight:600;padding:8px 0}
table.text-equivalent th,table.text-equivalent td{border-bottom:1px solid #e5e7eb;padding:6px 10px;text-align:left;vertical-align:top;font-size:13px}
table.text-equivalent th{background:#f3f4f6;font-weight:600}
table.text-equivalent td.entity-id{font-family:ui-monospace,Consolas,"Courier New",monospace;white-space:nowrap;word-break:break-all;max-width:320px}
footer.artifact-footer{padding:12px 24px;border-top:1px solid #e5e7eb;background:#ffffff;color:#4b5563;font-size:12px;word-break:break-word}
h2{font-size:14px;margin:8px 0}
noscript p{padding:8px 24px;color:#78350f}`;

/** @param {string} text @returns {string} base64 sha256 (CSP hash source) */
export function cspHashOf(text) {
  return createHash('sha256').update(text, 'utf8').digest('base64');
}

/** Hash of the fixed inline script. */
export const SCRIPT_HASH = cspHashOf(INLINE_SCRIPT);
/** Hash of the fixed inline stylesheet. */
export const STYLE_HASH = cspHashOf(INLINE_STYLE);

/**
 * Build the Content-Security-Policy string for the fixed inline script hash.
 * The style hash is fixed because the stylesheet is fixed.
 * @param {string} script_hash base64 sha256 of the inline script
 * @returns {string}
 */
export function cspFor(script_hash) {
  if (typeof script_hash !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(script_hash)) {
    throw new TypeError('script_hash must be a base64 sha256 (44 characters)');
  }
  return [
    "default-src 'none'",
    'img-src data:',
    `style-src 'sha256-${STYLE_HASH}'`,
    `script-src 'sha256-${script_hash}'`,
    "connect-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

/** @param {unknown} value @returns {string} */
function text(value) {
  return typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
}

/** @param {unknown} value @returns {string} */
function esc(value) {
  return escXml(text(value));
}

/**
 * Escape a value for a double-quoted HTML attribute. Single quotes stay literal
 * so fixed strings such as the CSP keywords remain byte-comparable.
 * @param {unknown} value
 * @returns {string}
 */
function escAttr(value) {
  return text(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Serialize an HTML element. HTML void elements are not used through this
 * helper, so an empty element is always written as an explicit open/close pair
 * (a bare `<span/>` would be mis-parsed by HTML parsers).
 * @param {string} tagName
 * @param {Record<string, string|number|undefined|null>} attributes
 * @param {string} [content]
 * @returns {string}
 */
function tag(tagName, attributes, content) {
  const parts = [];
  for (const [name, value] of Object.entries(attributes)) {
    if (value === undefined || value === null) continue;
    parts.push(`${name}="${escAttr(value)}"`);
  }
  const serialized = parts.length > 0 ? `${tagName} ${parts.join(' ')}` : tagName;
  return `<${serialized}>${content ?? ''}</${tagName}>`;
}

/**
 * Build the offline HTML artifact for a rendered diagram.
 * @param {object} input
 * @param {any} input.spec
 * @param {any} [input.overlay]
 * @param {any} [input.layout]
 * @param {string} [input.svg]
 * @param {{id:string,text:string}[]} [input.text_equivalent]
 * @param {{kind:string,label:string,count:number}[]} [input.legend]
 * @param {{nodes:string[],edges:string[],count:number}} [input.hidden]
 * @param {any} [input.manifest]
 * @param {string} [input.renderer_ref]
 * @param {string} [input.source_state]
 * @returns {{html:string, script_hash:string}}
 */
export function renderHtml(input = {}) {
  const spec = input.spec;
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new TypeError('spec must be an object');
  }
  const providedSvg = typeof input.svg === 'string' && input.svg.length > 0;
  const rendered = providedSvg
    ? {
        svg: input.svg,
        text_equivalent: Array.isArray(input.text_equivalent) ? input.text_equivalent : [],
        legend: Array.isArray(input.legend) ? input.legend : [],
        hidden: input.hidden ?? { nodes: [], edges: [], count: 0 },
      }
    : renderSvg(spec, { overlay: input.overlay, layout: input.layout });
  if (rendered.svg.length > LIMITS.package_bytes) {
    throw new RangeError('SVG document exceeds the artifact package limit');
  }
  const scriptHash = cspHashOf(INLINE_SCRIPT);
  const csp = cspFor(scriptHash);
  const sourceState = text(input.source_state || spec.source_state || 'unknown');
  const rendererRef = text(input.renderer_ref || spec.renderer_ref || '');
  const generatedAt = text(spec.generated_at ?? '');
  const manifest = input.manifest;
  const specDigest = manifest && typeof manifest === 'object' ? text(manifest.spec_digest ?? '') : '';
  const artifactId = manifest && typeof manifest === 'object' ? text(manifest.artifact_id ?? '') : '';

  const title = text(spec.title) || 'diagram';
  const legend = rendered.legend;
  const hidden = rendered.hidden ?? { nodes: [], edges: [], count: 0 };
  const textEquivalent = rendered.text_equivalent;

  const sources = Array.isArray(spec.sources) ? spec.sources : [];
  const sourceLines = sources.map((source) => {
    const id = text(source?.source_id);
    const snapshot = text(source?.snapshot_ref);
    const repos = Array.isArray(source?.repos) ? source.repos : [];
    const repoIds = repos.map((repo) => text(repo?.repo_id)).filter((value) => value.length > 0).sort();
    return `${id}@${snapshot}${repoIds.length > 0 ? ` [${repoIds.join(', ')}]` : ''}`;
  });
  const sourceBarRows = [
    ['diagram', text(spec.diagram_id)],
    ['revision', text(spec.revision)],
    ['mode', text(spec.mode)],
    ['source_state', sourceState],
    ['title', title],
    ['generated_at', generatedAt],
    ['renderer', rendererRef],
    ['sources', sourceLines.length > 0 ? sourceLines.join('; ') : '（无来源身份）'],
    ['spec_digest', specDigest],
    ['artifact_id', artifactId],
  ]
    .filter(([, value]) => value !== '')
    .map(([name, value]) => tag('div', {}, `${tag('dt', {}, esc(name))}${tag('dd', {}, esc(value))}`))
    .join('');

  // Warnings: unresolved relations, coverage truncation, hidden evidence,
  // stale/unknown source identity. Fixed text only (data goes through esc()).
  const warnings = [];
  const coverage = spec.coverage && typeof spec.coverage === 'object' ? spec.coverage : {};
  const unresolvedCount = Number.isSafeInteger(coverage.unresolved_count)
    ? coverage.unresolved_count
    : (spec.edges ?? []).filter((edge) => edge?.certainty === 'unresolved').length;
  if (unresolvedCount > 0) {
    warnings.push(`未解析关系：${unresolvedCount} 项；它们不是 exact，不能当作已证实调用。`);
  }
  if (coverage.truncated === true) {
    const omittedNodes = Number.isSafeInteger(coverage.omitted_nodes) ? coverage.omitted_nodes : 0;
    const omittedEdges = Number.isSafeInteger(coverage.omitted_edges) ? coverage.omitted_edges : 0;
    warnings.push(`覆盖已截断：省略节点 ${omittedNodes} 个、边 ${omittedEdges} 条；结果只覆盖显式选定范围。`);
  }
  if (coverage.complete !== true) warnings.push('coverage.complete=false：v1 不承诺全仓完整。');
  if (sourceState === 'stale') warnings.push('来源状态为 stale：源快照与生成时登记身份不一致，旧定位不能当作当前已验证。');
  if (sourceState === 'unknown') warnings.push('来源状态为 unknown：缺少当前登记身份，不能当作当前快照。');
  if (hidden.count > 0) {
    warnings.push(`已隐藏证据：节点 ${hidden.nodes.length} 个、边 ${hidden.edges.length} 条；base 事实未删除，仍计入覆盖范围。`);
  }
  const warningMarkup =
    warnings.length > 0
      ? warnings.map((warning) => tag('li', {}, esc(warning))).join('')
      : tag('li', { class: 'none' }, '无未解析、截断或隐藏项。');

  const legendMarkup = legend
    .map((entry) =>
      tag(
        'li',
        { class: `legend-item certainty-${text(entry.kind)}`, 'data-filter-certainty': text(entry.kind) },
        `${tag('span', { class: 'swatch' })}${tag('span', { class: 'legend-label' }, esc(entry.label))}${tag('span', { class: 'count' }, esc(entry.count))}`,
      ),
    )
    .join('');

  const tableRows = textEquivalent
    .map((row) =>
      tag('tr', {}, `${tag('td', { class: 'entity-id' }, esc(row.id))}${tag('td', {}, esc(row.text))}`),
    )
    .join('');
  const tableCaption = tag(
    'caption',
    {},
    esc(`文字等价（节点 ${textEquivalent.filter((row) => text(row.text).startsWith('[节点]')).length}，边 ${textEquivalent.filter((row) => text(row.text).startsWith('[边]')).length}）：图的可读文本替代，不替代证据本身。`),
  );

  const footerParts = [`source_state=${sourceState}`];
  if (text(spec.mode) !== '') footerParts.push(`mode=${text(spec.mode)}`);
  if (generatedAt !== '') footerParts.push(`generated_at=${generatedAt}`);
  if (rendererRef !== '') footerParts.push(`renderer=${rendererRef}`);
  const footer = tag('footer', { class: 'artifact-footer' }, esc(footerParts.join('  ·  ')));

  const html = [
    '<!DOCTYPE html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8"/>',
    '<meta name="viewport" content="width=device-width, initial-scale=1"/>',
    `<meta http-equiv="Content-Security-Policy" content="${escAttr(csp)}"/>`,
    `<title>${esc(title)}</title>`,
    `<style>${INLINE_STYLE}</style>`,
    '</head>',
    '<body data-zoom="1">',
    tag('header', { class: 'source-bar' }, `${tag('h1', {}, esc(title))}${tag('dl', {}, sourceBarRows)}`),
    '<main>',
    tag('section', { class: 'warnings', 'aria-label': '警告' }, `<h2>警告与范围</h2><ul class="warnings">${warningMarkup}</ul>`),
    tag('section', { class: 'legend', 'aria-label': '置信图例' }, `<h2>置信图例</h2><ul>${legendMarkup}</ul>`),
    tag('section', { class: 'diagram', 'aria-label': '图' }, `<div class="viewport-wrap">${tag('div', { id: 'diagram-viewport' }, rendered.svg)}</div>${tag('div', { id: 'ld-selection', 'aria-live': 'polite' })}`),
    tag('section', { class: 'text-equivalent-section' }, `<h2>文字等价</h2>${tag('table', { class: 'text-equivalent' }, `${tableCaption}<thead><tr><th scope="col">实体 ID</th><th scope="col">文本等价</th></tr></thead><tbody>${tableRows}</tbody>`)}`),
    '</main>',
    footer,
    '<noscript><p>本页脚本已按 CSP 禁用；图与文字等价内容仍然可读，脚本只提供选中、图例过滤和缩放。</p></noscript>',
    `<script>${INLINE_SCRIPT}</script>`,
    '</body>',
    '</html>',
  ].join('');

  return { html, script_hash: scriptHash };
}
