#!/usr/bin/env node
/**
 * 06 local diagrams — network smoke (DIA-05 outlet, T3).
 *
 * Negative outlet test: install an in-process recording guard over the Node
 * network entry points, then run the *builtin* fixture render and asset/resource
 * verification in this same process. Every attempted connection is recorded and
 * fails; the pass criterion is **zero attempted connections** (not "no
 * successful connection").
 *
 * Guard scope is a this-process JS audit boundary: `node:net` (`connect`,
 * `createConnection`, `Socket.prototype.connect`), `node:tls.connect`,
 * `node:dns` lookup/resolve* (callbacks and promises), `node:http`/`node:https`
 * request/get, `node:http2.connect`, `globalThis.fetch`, and
 * `globalThis.WebSocket` when present. It is NOT OS-level isolation and does not
 * cover Chromium, native addons, external executables, or core-ESM named
 * imports captured before patching; those limits are printed in the evidence
 * and must not be claimed as verified.
 *
 * Renderer policy: only `builtin` is runnable. Atlas is investigation-only and
 * Archify/Drawio have no adopted, locked executor (`source-lock.commands` is
 * empty), so asking for them is reported as a skipped renderer, never as a
 * passed one. The builtin render is invoked in-process: first through
 * `src/archive.mjs` `renderLocal` when present (the real packaging path), else
 * through the direct `layout`+`render-svg`+`render-html`+`assets` pipeline
 * (same builtin renderer modules), else through an in-process import of
 * `tools/render.mjs` when that CLI exists. If none is available the tool exits
 * 3 with `dependency_missing` and says so.
 *
 * Usage:
 *   node tools/network-smoke.mjs --isolated --renderers builtin [--out DIR] [--keep-artifacts]
 *   node tools/network-smoke.mjs --self-test-guard
 *
 * Exit codes: 0 pass; 1 verification/guard failure; 2 usage/source-lock error;
 * 3 renderer dependency missing; 5 guard self-test failure.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import dns from 'node:dns';
import dnsPromises from 'node:dns/promises';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import tls from 'node:tls';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { sha256Hex } from '../src/canonical.mjs';
import { LIMITS } from '../src/limits.mjs';
import { assertNoRemoteRefs } from '../src/runner.mjs';
import { adoptionSummary, parseSourceLock, SOURCE_LOCK_FILENAME } from '../src/source-lock.mjs';

const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(TOOL_DIR, '..');
const FIXTURE_INPUT_PATH = path.join(PROJECT_ROOT, 'tests', 'fixtures', 'conceptual', 'input.json');
const SOURCE_LOCK_PATH = path.join(PROJECT_ROOT, SOURCE_LOCK_FILENAME);
const BUILTIN_RENDERER_REF = 'builtin:renderer-v1';
const FIXED_GENERATED_AT = '2026-11-07T00:00:00.000Z';
const EXIT = Object.freeze({ PASS: 0, VERIFY_FAILED: 1, USAGE: 2, DEPENDENCY_MISSING: 3, GUARD_SELF_TEST_FAILED: 5 });

/* ------------------------------------------------------------------------- *
 * Recording network guard
 * ------------------------------------------------------------------------- */

const GUARDED_API_LIST = Object.freeze([
  'node:net.connect',
  'node:net.createConnection',
  'node:net.Socket.prototype.connect',
  'node:tls.connect',
  'node:dns.lookup',
  'node:dns.resolve*',
  'node:dns.reverse',
  'node:dns/promises.lookup',
  'node:dns/promises.resolve*',
  'node:http.request',
  'node:http.get',
  'node:https.request',
  'node:https.get',
  'node:http2.connect',
  'globalThis.fetch',
  'globalThis.WebSocket',
]);

const GUARD_LIMITATIONS = Object.freeze([
  'This guard is a this-process JavaScript audit boundary; it is not OS-level isolation and says nothing about firewall, browser, or native-code behavior.',
  'Core-ESM named imports (for example `import { connect } from "node:net"`) are bound before patching and cannot be intercepted by this in-process guard; module-object/default calls and process globals are intercepted.',
  'No claim is made about Chromium/WebView CSP, native addons, external executables, or other processes; those are separate outlet gates.',
]);

/** @param {unknown} value @param {number} [max] @returns {string} */
function clipTarget(value, max = 512) {
  let text;
  if (typeof value === 'string') text = value;
  else if (value === null || value === undefined) text = String(value);
  else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  return text.replace(/[\u0000-\u001f]/g, ' ').slice(0, max);
}

/** @param {string} api @param {unknown} target */
function blockedNetworkCall(api, target) {
  const error = new Error(`NETWORK_BLOCKED:${api} (network-smoke guard)`);
  error.code = 'NETWORK_BLOCKED';
  error.network_smoke = { api, target: clipTarget(target) };
  throw error;
}

/** Describe the target of net/tls connect-style arguments. */
function describeConnectTarget(args) {
  const first = args[0];
  if (typeof first === 'string') return first;
  if (Array.isArray(first)) return `${clipTarget(first[1])}:${clipTarget(first[0])}`;
  if (first !== null && typeof first === 'object') {
    const host = first.host ?? first.hostname ?? first.path ?? 'unknown-host';
    const port = first.port ?? first.remotePort ?? '?';
    return `${clipTarget(host)}:${clipTarget(port)}`;
  }
  return 'unknown-target';
}

/** Describe the target of http(s).request/get arguments. */
function describeHttpTarget(args) {
  const first = args[0];
  if (typeof first === 'string') return first;
  if (first instanceof URL) return first.href;
  if (first !== null && typeof first === 'object') {
    const protocol = first.protocol ?? 'http:';
    const host = first.host ?? first.hostname ?? 'unknown-host';
    const port = first.port ?? '';
    const requestPath = first.path ?? '/';
    return `${clipTarget(protocol)}//${clipTarget(host)}${port === '' ? '' : `:${clipTarget(port)}`}${clipTarget(requestPath)}`;
  }
  return 'unknown-target';
}

/** Describe a fetch/WebSocket input. */
function describeUrlTarget(input) {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  if (input !== null && typeof input === 'object' && typeof input.url === 'string') return input.url;
  return clipTarget(input);
}

/**
 * Install the guard. Returns attempt records plus an `uninstall()` that
 * restores every patched function. Safe to call once per process.
 * @param {{clock?:() => string}} [options]
 * @returns {{attempts:object[], patched_apis:string[], installed:boolean, uninstall:() => void}}
 */
function installNetworkGuard(options = {}) {
  const clock = options.clock ?? (() => new Date().toISOString());
  /** @type {object[]} */
  const attempts = [];
  /** @type {string[]} */
  const patchedApis = [];
  /** @type {(() => void)[]} */
  const restoreCallbacks = [];

  /** @param {string} api @param {unknown} target @returns {never} */
  const block = (api, target) => {
    attempts.push({ api, target: clipTarget(target), at: clock(), blocked: true, error_code: 'NETWORK_BLOCKED' });
    return blockedNetworkCall(api, target);
  };

  /** @param {any} owner @param {string} key @param {string} api @param {(args:any[]) => unknown} [describe] */
  const patchFunction = (owner, key, api, describe) => {
    if (owner === null || owner === undefined) return;
    const original = owner[key];
    if (typeof original !== 'function') return;
    owner[key] = function networkSmokeBlocked(...args) {
      return block(api, describe ? describe(args) : 'n/a');
    };
    restoreCallbacks.push(() => {
      owner[key] = original;
    });
    patchedApis.push(api);
  };

  // node:net
  patchFunction(net, 'connect', 'node:net.connect', describeConnectTarget);
  patchFunction(net, 'createConnection', 'node:net.createConnection', describeConnectTarget);
  patchFunction(net.Socket?.prototype, 'connect', 'node:net.Socket.prototype.connect', describeConnectTarget);
  // node:tls
  patchFunction(tls, 'connect', 'node:tls.connect', describeConnectTarget);
  // node:dns (callbacks)
  for (const method of ['lookup', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCaa', 'resolveCname', 'resolveMx', 'resolveNs', 'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTxt', 'resolveNaptr', 'reverse']) {
    patchFunction(dns, method, `node:dns.${method}`, (args) => args[0]);
  }
  // node:dns/promises
  for (const method of ['lookup', 'resolve', 'resolve4', 'resolve6', 'any', 'caa', 'cname', 'mx', 'ns', 'ptr', 'soa', 'srv', 'txt', 'reverse']) {
    patchFunction(dnsPromises, method, `node:dns/promises.${method}`, (args) => args[0]);
  }
  // node:http / node:https
  patchFunction(http, 'request', 'node:http.request', describeHttpTarget);
  patchFunction(http, 'get', 'node:http.get', describeHttpTarget);
  patchFunction(https, 'request', 'node:https.request', describeHttpTarget);
  patchFunction(https, 'get', 'node:https.get', describeHttpTarget);
  // node:http2
  patchFunction(http2, 'connect', 'node:http2.connect', describeConnectTarget);
  // global fetch
  if (typeof globalThis.fetch === 'function') {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = function networkSmokeBlockedFetch(input, init) {
      void init;
      return Promise.reject(
        (() => {
          attempts.push({ api: 'globalThis.fetch', target: clipTarget(describeUrlTarget(input)), at: clock(), blocked: true, error_code: 'NETWORK_BLOCKED' });
          const error = new Error('NETWORK_BLOCKED:globalThis.fetch (network-smoke guard)');
          error.code = 'NETWORK_BLOCKED';
          error.network_smoke = { api: 'globalThis.fetch', target: clipTarget(describeUrlTarget(input)) };
          return error;
        })(),
      );
    };
    restoreCallbacks.push(() => {
      globalThis.fetch = originalFetch;
    });
    patchedApis.push('globalThis.fetch');
  }
  // global WebSocket (when the runtime provides it)
  if (typeof globalThis.WebSocket === 'function') {
    const OriginalWebSocket = globalThis.WebSocket;
    class NetworkSmokeBlockedWebSocket {
      constructor(url) {
        block('globalThis.WebSocket', describeUrlTarget(url));
      }
    }
    globalThis.WebSocket = NetworkSmokeBlockedWebSocket;
    restoreCallbacks.push(() => {
      globalThis.WebSocket = OriginalWebSocket;
    });
    patchedApis.push('globalThis.WebSocket');
  }

  let installed = true;
  return {
    attempts,
    patched_apis: patchedApis,
    get installed() {
      return installed;
    },
    uninstall() {
      if (!installed) return;
      installed = false;
      for (const restore of restoreCallbacks.reverse()) restore();
      restoreCallbacks.length = 0;
    },
  };
}

/* ------------------------------------------------------------------------- *
 * Builtin render workload
 * ------------------------------------------------------------------------- */

/** @param {string} projectRoot */
function readFixtureInput(projectRoot) {
  const fixturePath = path.join(projectRoot, 'tests', 'fixtures', 'conceptual', 'input.json');
  const fallback = {
    title: '概念图：网络冒烟 fixture',
    scope_ref: 'ws:network-smoke',
    nodes: [
      { id: 'step:build', label: '构建产物', kind: 'module' },
      { id: 'step:sign', label: '签名', kind: 'module' },
      { id: 'step:publish', label: '发布', kind: 'module' },
    ],
    edges: [
      { from: 'step:build', to: 'step:sign', kind: 'control', label: '进入签名', description: '构建完成后提交签名。' },
      { from: 'step:sign', to: 'step:publish', kind: 'control', label: '签名通过后发布', description: null },
    ],
  };
  try {
    return { input: JSON.parse(readFileSync(fixturePath, 'utf8')), source: path.relative(projectRoot, fixturePath).replace(/\\/g, '/') };
  } catch {
    return { input: fallback, source: 'inline-fallback' };
  }
}

/** @param {{nodes:any[], edges:any[]}} conceptualInput */
function buildFixtureSpec(conceptualInput) {
  const nodes = conceptualInput.nodes.map((node) => ({
    id: node.id,
    label: node.label,
    kind: node.kind ?? 'module',
    origin: 'annotation',
    evidence_refs: [],
    description: null,
  }));
  const edges = conceptualInput.edges.map((edge, index) => ({
    id: `edge:${index}`,
    from: edge.from,
    to: edge.to,
    kind: edge.kind ?? 'annotation',
    certainty: 'unknown',
    origin: 'annotation',
    label: edge.label ?? `关系 ${index + 1}`,
    evidence_refs: [],
    explanation: edge.description ?? null,
  }));
  return {
    schema_version: 1,
    diagram_id: 'conceptual:network-smoke',
    revision: 0,
    mode: 'conceptual',
    title: conceptualInput.title ?? '概念图',
    scope_ref: conceptualInput.scope_ref ?? 'ws:network-smoke',
    sources: [],
    nodes,
    edges,
    layout: { algorithm: 'layered_v1', direction: 'LR', positions: [] },
    coverage: { complete: false, truncated: false, omitted_nodes: 0, omitted_edges: 0, unresolved_count: 0, notes: [] },
    source_state: 'unknown',
    generated_at: FIXED_GENERATED_AT,
    renderer_ref: BUILTIN_RENDERER_REF,
  };
}

/** @param {string} root @param {Record<string,string>} wanted @returns {Promise<{loaded:Record<string,any>, missing:string[], errors:object[]}>} */
async function tryLoadModules(root, wanted) {
  /** @type {Record<string, any>} */
  const loaded = {};
  /** @type {string[]} */
  const missing = [];
  /** @type {object[]} */
  const errors = [];
  for (const [name, relativePath] of Object.entries(wanted)) {
    const absolutePath = path.join(root, relativePath);
    if (!existsSync(absolutePath)) {
      missing.push(relativePath);
      continue;
    }
    try {
      loaded[name] = await import(pathToFileURL(absolutePath).href);
    } catch (error) {
      errors.push({
        module: relativePath,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { loaded, missing, errors };
}

/** @param {string} directory @param {number} [depth] @returns {string[]} sorted relative paths */
function listFilesRecursive(directory, depth = 0) {
  if (depth > 8) return [];
  /** @type {string[]} */
  const out = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      for (const nested of listFilesRecursive(absolute, depth + 1)) out.push(`${entry.name}/${nested}`);
    } else if (entry.isFile()) {
      out.push(entry.name);
    }
  }
  return out.sort();
}

/** @param {string} directory @returns {string|null} */
function findArtifactRoot(directory) {
  if (!existsSync(directory)) return null;
  if (existsSync(path.join(directory, 'index.html'))) return directory;
  /** @type {string[]} */
  const queue = [directory];
  let visited = 0;
  while (queue.length > 0 && visited < 200) {
    const current = queue.shift();
    visited += 1;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const child = path.join(current, entry.name);
      if (existsSync(path.join(child, 'index.html'))) return child;
      queue.push(child);
    }
  }
  return null;
}

const TEXT_EXTENSIONS = new Set(['.html', '.htm', '.svg', '.json', '.css', '.js', '.mjs', '.xml']);

/**
 * Verify rendered artifact bytes: resource manifest, offline HTML policy,
 * remote-reference scan, and file inventory. Uses the project's own
 * `src/assets.mjs` verifiers when available.
 * @param {string} artifactRoot
 * @param {{assets?:any}} modules
 * @returns {{ok:boolean, files:{relative_path:string, size:number, sha256:string}[], manifest:object, html:object, remote_refs:object, errors:object[]}}
 */
function verifyArtifactBytes(artifactRoot, modules) {
  /** @type {object[]} */
  const errors = [];
  /** @type {{relative_path:string, size:number, sha256:string}[]} */
  const files = [];
  for (const relativePath of listFilesRecursive(artifactRoot)) {
    const absolute = path.join(artifactRoot, relativePath);
    const stats = statSync(absolute);
    files.push({ relative_path: relativePath, size: stats.size, sha256: sha256Hex(readFileSync(absolute)) });
  }

  /** @type {object} */
  const manifestReport = { present: false, ok: false, files: 0, verifier: 'src/assets.mjs verifyResourceManifest', errors: [] };
  const manifestPath = path.join(artifactRoot, 'manifest.json');
  if (existsSync(manifestPath)) {
    manifestReport.present = true;
    let manifest = null;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch (error) {
      errors.push({ path: 'manifest.json', keyword: 'json', message: error instanceof Error ? error.message : String(error) });
    }
    if (manifest !== null) {
      if (modules.assets && typeof modules.assets.verifyResourceManifest === 'function') {
        const verified = modules.assets.verifyResourceManifest(manifest, { root: artifactRoot, limits: LIMITS });
        manifestReport.ok = verified.ok === true;
        manifestReport.files = Array.isArray(manifest.files) ? manifest.files.length : 0;
        manifestReport.errors = verified.errors ?? [];
        if (!verified.ok) errors.push(...(verified.errors ?? []).map((error) => ({ ...error, source: 'verifyResourceManifest' })));
      } else {
        // No verifier available: never claim the manifest matched.
        manifestReport.errors = [{ path: 'manifest.json', keyword: 'skipped', message: 'src/assets.mjs unavailable; manifest not re-verified' }];
        errors.push({ path: 'manifest.json', keyword: 'verification_skipped', message: 'src/assets.mjs unavailable; manifest not re-verified' });
      }
    }
  } else {
    manifestReport.errors = [{ path: 'manifest.json', keyword: 'missing', message: 'artifact root has no manifest.json' }];
    errors.push({ path: 'manifest.json', keyword: 'missing', message: 'artifact root has no manifest.json' });
  }

  /** @type {object} */
  const htmlReport = { present: false, ok: false, verifier: 'src/assets.mjs verifyAtlasArtifact (offline HTML scan)', errors: [] };
  const htmlPath = path.join(artifactRoot, 'index.html');
  if (existsSync(htmlPath)) {
    htmlReport.present = true;
    if (modules.assets && typeof modules.assets.verifyAtlasArtifact === 'function') {
      const verified = modules.assets.verifyAtlasArtifact(htmlPath, { allowed_root: artifactRoot, limits: LIMITS });
      htmlReport.ok = verified.ok === true;
      htmlReport.errors = verified.errors ?? [];
      if (!verified.ok) errors.push(...(verified.errors ?? []).map((error) => ({ ...error, source: 'verifyAtlasArtifact' })));
    } else {
      htmlReport.errors = [{ path: 'index.html', keyword: 'skipped', message: 'src/assets.mjs unavailable; offline HTML not re-verified' }];
      errors.push({ path: 'index.html', keyword: 'verification_skipped', message: 'src/assets.mjs unavailable; offline HTML not re-verified' });
    }
  } else {
    htmlReport.errors = [{ path: 'index.html', keyword: 'missing', message: 'artifact root has no index.html' }];
    errors.push({ path: 'index.html', keyword: 'missing', message: 'artifact root has no index.html' });
  }

  /** @type {object[]} */
  const remoteFindings = [];
  for (const file of files) {
    const extension = path.extname(file.relative_path).toLowerCase();
    if (!TEXT_EXTENSIONS.has(extension)) continue;
    const absolute = path.join(artifactRoot, file.relative_path);
    const text = readFileSync(absolute, 'utf8');
    const scan = assertNoRemoteRefs(text);
    if (!scan.ok) {
      for (const finding of scan.errors) remoteFindings.push({ file: file.relative_path, ...finding });
    }
  }
  if (remoteFindings.length > 0) {
    errors.push({ path: '$', keyword: 'remote_refs', message: `${remoteFindings.length} remote-reference finding(s) in generated artifact bytes` });
  }

  const offlinePolicy = modules.assets && typeof modules.assets.offlinePolicy === 'function' ? modules.assets.offlinePolicy() : null;
  return {
    ok: errors.length === 0,
    files,
    manifest: manifestReport,
    html: htmlReport,
    remote_refs: { ok: remoteFindings.length === 0, findings: remoteFindings },
    offline_policy: offlinePolicy,
    errors,
  };
}

/**
 * Run the builtin fixture render in-process. Returns a workload report; the
 * caller treats `status !== 'executed'` or `!verification.ok` as not passing.
 * @param {{projectRoot:string, outDir:string}} input
 */
async function runBuiltinWorkload({ projectRoot, outDir }) {
  /** @type {{seam:string, status:string, steps:object[], modules:object, missing:string[], errors:object[]}} */
  const workload = {
    renderer: 'builtin',
    renderer_ref: BUILTIN_RENDERER_REF,
    mode: 'in-process',
    seam: 'pending',
    status: 'pending',
    fixture: readFixtureInput(projectRoot).source,
    steps: [],
    modules: {},
    missing: [],
    errors: [],
  };
  const step = (name, detail = {}) => workload.steps.push({ name, at: new Date().toISOString(), ...detail });

  const deps = await tryLoadModules(projectRoot, {
    contracts: 'src/contracts.mjs',
    layout: 'src/layout.mjs',
    renderSvg: 'src/render-svg.mjs',
    renderHtml: 'src/render-html.mjs',
    assets: 'src/assets.mjs',
    archive: 'src/archive.mjs',
    evidence: 'src/evidence.mjs',
  });
  workload.missing = deps.missing;
  workload.modules = Object.keys(deps.loaded);
  workload.errors.push(...deps.errors);
  if (deps.errors.length > 0) {
    workload.seam = 'module-import';
    workload.status = 'failed';
    return workload;
  }

  const have = (name) => Boolean(deps.loaded[name]);
  const fixture = readFixtureInput(projectRoot).input;

  if (have('archive') && have('evidence') && have('contracts') && have('assets')) {
    workload.seam = 'in-process-src-archive-renderLocal';
    step('modules-loaded', { modules: workload.modules });
    return await runArchiveWorkload({ projectRoot, outDir, deps, fixture, workload, step });
  }

  if (have('contracts') && have('layout') && have('renderSvg') && have('renderHtml') && have('assets')) {
    workload.seam = 'in-process-direct-pipeline(layout+render-svg+render-html+assets)';
    step('modules-loaded', { modules: workload.modules });
    return await runDirectPipelineWorkload({ projectRoot, outDir, deps, fixture, workload, step });
  }

  const cliPath = path.join(projectRoot, 'tools', 'render.mjs');
  if (existsSync(cliPath)) {
    workload.seam = 'in-process-tools/render.mjs-import';
    step('modules-loaded', { modules: workload.modules });
    return await runRenderCliInProcess({ projectRoot, outDir, cliPath, workload, step });
  }

  workload.seam = 'missing';
  workload.status = 'dependency_missing';
  workload.errors.push({
    path: '$',
    keyword: 'dependency',
    message:
      'no builtin render path available: need src/archive.mjs+src/evidence.mjs or layout/render-svg/render-html/assets, or tools/render.mjs',
  });
  return workload;
}

/** Tier A: the real renderLocal packaging path. */
async function runArchiveWorkload({ outDir, deps, fixture, workload, step }) {
  const { contracts, evidence, archive, assets } = deps.loaded;
  try {
    // Fixed clock + empty overlay keep the fixture artifact bytes deterministic
    // across smoke runs; the smoke is not asserting anything about wall time.
    const spec =
      typeof evidence.emptyConceptualSpec === 'function'
        ? evidence.emptyConceptualSpec(fixture, { clock: () => FIXED_GENERATED_AT })
        : null;
    if (spec === null) {
      workload.status = 'failed';
      workload.errors.push({ path: 'src/evidence.mjs', keyword: 'export', message: 'emptyConceptualSpec is not exported' });
      return workload;
    }
    const validation = contracts.validateDiagramSpec(spec);
    if (!validation || validation.ok !== true) {
      workload.status = 'failed';
      workload.errors.push({ path: 'spec', keyword: 'INVALID_SPEC', message: 'generated fixture spec failed validateDiagramSpec' });
      return workload;
    }
    step('spec-built', { diagram_id: spec.diagram_id, nodes: spec.nodes.length, edges: spec.edges.length });

    // Exact T2 seam: output_ref is a safe *relative* directory ref and the
    // trusted caller grant carries the absolute output root.
    const overlay = contracts.emptyOverlay({
      diagram_id: spec.diagram_id,
      base_spec_digest: contracts.specDigest(spec),
      now: FIXED_GENERATED_AT,
    });
    const request = {
      spec,
      overlay,
      output_ref: 'artifact',
      renderer: 'builtin',
      expected_output_revision: null,
      operation_id: 'network-smoke-builtin',
    };
    const caller = { granted: true, granted_output_root: outDir };
    const result = await archive.renderLocal(request, caller, undefined);
    if (!result || result.status !== 'saved') {
      workload.status = 'failed';
      workload.errors.push({
        path: 'renderLocal',
        keyword: 'status',
        message: `renderLocal returned ${JSON.stringify(result).slice(0, 500)}; expected status 'saved'`,
      });
      return workload;
    }
    step('renderLocal-saved', { artifact_ref: result.artifact_ref, manifest_digest: result.manifest_digest });

    const artifactRoot = existsSync(result.artifact_ref)
      ? result.artifact_ref
      : findArtifactRoot(outDir);
    if (artifactRoot === null || !existsSync(path.join(artifactRoot, 'index.html'))) {
      workload.status = 'failed';
      workload.errors.push({ path: 'artifact_ref', keyword: 'artifact', message: 'renderLocal saved but no index.html artifact was found' });
      return workload;
    }
    step('artifact-found', { artifact_root: artifactRoot });
    const verification = verifyArtifactBytes(artifactRoot, { assets });
    workload.artifact_dir = artifactRoot;
    workload.artifact_files = verification.files.map((file) => file.relative_path);
    workload.verification = verification;
    workload.manifest_digest = result.manifest_digest;
    workload.determinism = {
      artifact_dir_id: path.basename(artifactRoot),
      note: 'fixture spec/overlay are pinned, so the artifact directory id is deterministic; manifest_digest includes the archive created_at clock and varies per run',
    };
    workload.archive_layer = 'renderLocal (atomic staging + manifest)';
    workload.status = verification.ok ? 'executed' : 'failed';
    if (!verification.ok) workload.errors.push(...verification.errors);
    step('verified', { ok: verification.ok, files: verification.files.length });
    return workload;
  } catch (error) {
    workload.status = 'failed';
    workload.errors.push({ path: 'workload', keyword: 'exception', message: error instanceof Error ? error.message : String(error) });
    return workload;
  }
}

/** Tier B: direct builtin renderer modules without the archive layer. */
async function runDirectPipelineWorkload({ outDir, deps, fixture, workload, step }) {
  const { contracts, layout, renderSvg, renderHtml, assets } = deps.loaded;
  try {
    const spec = buildFixtureSpec(fixture);
    const validation = contracts.validateDiagramSpec(spec);
    if (!validation || validation.ok !== true) {
      workload.status = 'failed';
      workload.errors.push({
        path: 'spec',
        keyword: 'INVALID_SPEC',
        message: `fixture spec failed validateDiagramSpec: ${JSON.stringify(validation?.errors ?? []).slice(0, 500)}`,
      });
      return workload;
    }
    step('spec-built', { diagram_id: spec.diagram_id, nodes: spec.nodes.length, edges: spec.edges.length });

    const layoutResult = layout.layoutDiagram(spec, { direction: 'LR' });
    spec.layout = {
      algorithm: layoutResult.algorithm ?? 'layered_v1',
      direction: layoutResult.direction ?? 'LR',
      positions: layoutResult.positions,
    };
    const specValidation = contracts.validateDiagramSpec(spec);
    if (!specValidation || specValidation.ok !== true) {
      workload.status = 'failed';
      workload.errors.push({ path: 'spec.layout', keyword: 'INVALID_SPEC', message: 'spec with computed layout failed validation' });
      return workload;
    }
    step('layout-computed', { positions: layoutResult.positions.length });

    const rendered = renderSvg.renderSvg(spec, { layout: layoutResult });
    step('svg-rendered', { bytes: Buffer.byteLength(rendered.svg, 'utf8') });

    const renderedHtml = renderHtml.renderHtml({
      spec,
      layout: layoutResult,
      svg: rendered.svg,
      text_equivalent: rendered.text_equivalent,
      legend: rendered.legend,
      hidden: rendered.hidden,
      source_state: spec.source_state,
      renderer_ref: spec.renderer_ref,
      manifest: null,
    });
    const html = typeof renderedHtml === 'string' ? renderedHtml : renderedHtml.html;
    if (typeof html !== 'string' || html.length === 0) {
      workload.status = 'failed';
      workload.errors.push({ path: 'src/render-html.mjs', keyword: 'output', message: 'renderHtml returned no HTML text' });
      return workload;
    }
    step('html-rendered', { bytes: Buffer.byteLength(html, 'utf8') });

    mkdirSync(outDir, { recursive: true });
    writeFileSync(path.join(outDir, 'index.html'), html, 'utf8');
    writeFileSync(path.join(outDir, 'diagram.svg'), rendered.svg, 'utf8');
    writeFileSync(path.join(outDir, 'diagram-spec.json'), `${JSON.stringify(spec, null, 2)}\n`, 'utf8');
    writeFileSync(
      path.join(outDir, 'annotations.json'),
      `${JSON.stringify(
        {
          schema_version: 1,
          diagram_id: spec.diagram_id,
          base_spec_digest: contracts.specDigest(spec),
          revision: 0,
          items: [],
          orphaned_annotations: [],
          updated_at: spec.generated_at,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    step('artifact-written', { files: listFilesRecursive(outDir) });

    const builtManifest = assets.buildResourceManifest(['index.html', 'diagram.svg', 'diagram-spec.json', 'annotations.json'], {
      root: outDir,
      limits: LIMITS,
    });
    if (!builtManifest || builtManifest.ok !== true) {
      workload.status = 'failed';
      workload.errors.push({
        path: 'src/assets.mjs',
        keyword: 'manifest',
        message: `buildResourceManifest failed: ${JSON.stringify(builtManifest?.errors ?? []).slice(0, 500)}`,
      });
      return workload;
    }
    writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify(builtManifest.manifest, null, 2)}\n`, 'utf8');
    step('manifest-built', { files: builtManifest.manifest.files.length });

    const verification = verifyArtifactBytes(outDir, { assets });
    workload.artifact_dir = outDir;
    workload.artifact_files = verification.files.map((file) => file.relative_path);
    workload.verification = verification;
    workload.manifest = builtManifest.manifest;
    workload.manifest_digest = sha256Hex(JSON.stringify(builtManifest.manifest));
    // The direct pipeline is a renderer-level seam: it does not claim the
    // archive layer's atomic package semantics (that is T2's covered path).
    workload.archive_layer = 'not-used';
    workload.status = verification.ok ? 'executed' : 'failed';
    if (!verification.ok) workload.errors.push(...verification.errors);
    step('verified', { ok: verification.ok, files: verification.files.length });
    return workload;
  } catch (error) {
    workload.status = 'failed';
    workload.errors.push({ path: 'workload', keyword: 'exception', message: error instanceof Error ? error.message : String(error) });
    return workload;
  }
}

/** Tier C: in-process import of tools/render.mjs; only used when renderer modules are absent. */
async function runRenderCliInProcess({ projectRoot, outDir, cliPath, workload, step }) {
  try {
    const cliSource = readFileSync(cliPath, 'utf8');
    if (/process\.exit\s*\(/.test(cliSource)) {
      workload.status = 'dependency_missing';
      workload.errors.push({
        path: 'tools/render.mjs',
        keyword: 'seam',
        message: 'CLI calls process.exit(), so in-process invocation would terminate the smoke before evidence is emitted; renderer modules are the supported seam',
      });
      return workload;
    }
    const savedArgv = process.argv;
    process.argv = [process.execPath, cliPath, '--fixture', '--renderer', 'builtin', '--out', outDir];
    try {
      const cliModule = await import(`${pathToFileURL(cliPath).href}?network-smoke=${Date.now()}`);
      if (typeof cliModule.main === 'function') {
        await cliModule.main(['--fixture', '--renderer', 'builtin', '--out', outDir]);
      } else if (typeof cliModule.run === 'function') {
        await cliModule.run(['--fixture', '--renderer', 'builtin', '--out', outDir]);
      }
    } finally {
      process.argv = savedArgv;
    }
    const artifactRoot = findArtifactRoot(outDir);
    if (artifactRoot === null) {
      workload.status = 'failed';
      workload.errors.push({ path: 'tools/render.mjs', keyword: 'artifact', message: 'in-process CLI import produced no index.html artifact' });
      return workload;
    }
    const { loaded } = await tryLoadModules(projectRoot, { assets: 'src/assets.mjs' });
    const verification = verifyArtifactBytes(artifactRoot, { assets: loaded.assets });
    workload.artifact_dir = artifactRoot;
    workload.artifact_files = verification.files.map((file) => file.relative_path);
    workload.verification = verification;
    workload.status = verification.ok ? 'executed' : 'failed';
    if (!verification.ok) workload.errors.push(...verification.errors);
    step('verified', { ok: verification.ok, files: verification.files.length });
    return workload;
  } catch (error) {
    workload.status = 'failed';
    workload.errors.push({ path: 'tools/render.mjs', keyword: 'exception', message: error instanceof Error ? error.message : String(error) });
    return workload;
  }
}

/**
 * Static complement: scan the loaded render module sources for network imports
 * (runtime guard is authoritative; this only catches obvious import seams).
 * @param {string} projectRoot
 * @param {string[]} moduleNames
 * @returns {{ok:boolean, files:string[], findings:object[]}}
 */
function staticNetworkImportScan(projectRoot, moduleNames) {
  const files = [];
  const findings = [];
  const pattern = /(?:^|[^\w$])(?:from\s*|require\(\s*)['"](?:node:)?(?:net|http|https|http2|dns|tls)['"]/gmu;
  const moduleFiles = {
    contracts: 'src/contracts.mjs',
    layout: 'src/layout.mjs',
    renderSvg: 'src/render-svg.mjs',
    renderHtml: 'src/render-html.mjs',
    assets: 'src/assets.mjs',
    archive: 'src/archive.mjs',
    evidence: 'src/evidence.mjs',
  };
  for (const name of moduleNames) {
    const relative = moduleFiles[name];
    if (!relative) continue;
    const absolute = path.join(projectRoot, relative);
    if (!existsSync(absolute)) continue;
    const file = relative;
    files.push(file);
    const text = readFileSync(absolute, 'utf8');
    for (const match of text.matchAll(pattern)) {
      findings.push({ file, offset: match.index ?? 0, match: match[0].trim().slice(0, 120) });
    }
  }
  return { ok: findings.length === 0, files, findings };
}

/* ------------------------------------------------------------------------- *
 * Guard self-test
 * ------------------------------------------------------------------------- */

/** Prove the guard records and blocks each entry point without any real connection. */
async function runGuardSelfTest() {
  const guard = installNetworkGuard();
  /** @type {object[]} */
  const probes = [];
  const webSocketPresent = typeof globalThis.WebSocket === 'function';
  /** @param {string} api @param {() => unknown} call */
  const probe = async (api, call) => {
    const before = guard.attempts.length;
    let threw = false;
    let thrownCode = null;
    try {
      const result = call();
      if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
        try {
          await result;
        } catch (error) {
          threw = true;
          thrownCode = error !== null && typeof error === 'object' ? error.code ?? null : null;
        }
      }
    } catch (error) {
      threw = true;
      thrownCode = error !== null && typeof error === 'object' ? error.code ?? null : null;
    }
    probes.push({ api, recorded: guard.attempts.length > before, threw, thrown_code: thrownCode });
  };
  await probe('globalThis.fetch', () => globalThis.fetch('http://127.0.0.1:9/guard-self-test'));
  await probe('node:net.connect', () => net.connect({ host: '127.0.0.1', port: 9 }));
  await probe('node:dns.lookup', () => dns.lookup('127.0.0.1'));
  await probe('node:dns/promises.lookup', () => dnsPromises.lookup('127.0.0.1'));
  await probe('node:http.request', () => http.request('http://127.0.0.1:9/guard-self-test'));
  await probe('node:https.request', () => https.request('https://127.0.0.1:9/guard-self-test'));
  if (webSocketPresent) await probe('globalThis.WebSocket', () => new globalThis.WebSocket('ws://127.0.0.1:9/guard-self-test'));
  guard.uninstall();

  const guardedProbes = probes.filter((entry) => entry.api !== 'globalThis.WebSocket' || webSocketPresent);
  const pass = guardedProbes.length > 0 && guardedProbes.every((entry) => entry.recorded === true && entry.threw === true);
  const report = {
    schema_version: 1,
    tool: 'network-smoke',
    mode: 'guard-self-test',
    command: 'node tools/network-smoke.mjs --self-test-guard',
    generated_at: new Date().toISOString(),
    renderer: 'none',
    guard: {
      scope: 'this-process JS network entry points',
      patched_apis: guard.patched_apis,
      uninstalled: guard.installed === false,
      limitations: GUARD_LIMITATIONS,
    },
    probes,
    attempts: guard.attempts,
    attempted_count: guard.attempts.length,
    unregistered_attempts: guard.attempts.length,
    registered_attempts: 0,
    pass,
    exit_code: pass ? EXIT.PASS : EXIT.GUARD_SELF_TEST_FAILED,
    limitations: [
      'Self-test intentionally calls each guarded API; the guard blocks them synchronously and no real connection is attempted.',
      ...GUARD_LIMITATIONS,
    ],
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return pass ? EXIT.PASS : EXIT.GUARD_SELF_TEST_FAILED;
}

/* ------------------------------------------------------------------------- *
 * CLI
 * ------------------------------------------------------------------------- */

function usage() {
  return [
    'usage: node tools/network-smoke.mjs --isolated --renderers builtin [--out DIR] [--keep-artifacts]',
    '       node tools/network-smoke.mjs --self-test-guard',
    '',
    '  --isolated          required for the negative outlet test; records isolated:true',
    '  --renderers LIST    comma list; only builtin is runnable (atlas/archify/drawio are reported skipped)',
    '  --out DIR           artifact output directory (default: fresh temp dir, removed afterwards)',
    '  --keep-artifacts    keep the temp artifact directory for inspection',
    '  --self-test-guard   prove the recording guard blocks each network entry point',
    '',
    'Exit: 0 pass, 1 verification/guard failure, 2 usage/source-lock error, 3 renderer dependency missing, 5 guard self-test failure.',
    '',
  ].join('\n');
}

/** @param {string[]} argv @param {string} flag @returns {string|null} */
function argValue(argv, flag) {
  const index = argv.indexOf(flag);
  if (index === -1) return null;
  return argv[index + 1] ?? null;
}

async function main(argv) {
  if (argv.includes('--self-test-guard')) return runGuardSelfTest();
  if (argv.includes('--help') || argv.length === 0) {
    process.stdout.write(usage());
    return argv.length === 0 ? EXIT.USAGE : EXIT.PASS;
  }

  const isolated = argv.includes('--isolated');
  const renderersArg = argValue(argv, '--renderers');
  const requestedRenderers = (renderersArg ?? 'builtin')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  const knownRenderers = ['builtin', 'atlas', 'archify', 'drawio'];
  const unknownRenderers = requestedRenderers.filter((renderer) => !knownRenderers.includes(renderer));
  if (unknownRenderers.length > 0) {
    process.stderr.write(`network-smoke: unknown renderer(s): ${unknownRenderers.join(', ')}\n${usage()}`);
    return EXIT.USAGE;
  }
  if (!isolated) {
    process.stderr.write(`network-smoke: --isolated is required for the negative outlet test\n${usage()}`);
    return EXIT.USAGE;
  }

  const generatedAt = new Date().toISOString();
  /** @type {object[]} */
  const skippedRenderers = requestedRenderers
    .filter((renderer) => renderer !== 'builtin')
    .map((renderer) => ({
      renderer,
      status: 'skipped',
      reason:
        renderer === 'atlas'
          ? 'atlas-local is investigation-only in source-lock (adopted_files: []) and no local Atlas artifact is registered'
          : 'not adopted and no locked executor is registered in source-lock.commands; runner denies unregistered commands',
    }));

  /** @type {any} */
  const report = {
    schema_version: 1,
    tool: 'network-smoke',
    command: `node tools/network-smoke.mjs ${argv.join(' ')}`,
    generated_at: generatedAt,
    isolated: true,
    renderer: 'builtin',
    renderers_requested: requestedRenderers,
    renderers_run: [],
    skipped_renderers: skippedRenderers,
    runtime: { node: process.versions.node, platform: process.platform, arch: process.arch },
    source_lock: { path: SOURCE_LOCK_PATH, exists: false, sha256: null, parsed: false, errors: [], network_mode: null, remote_services: [], adopted_count: null, commands: null },
    guard: {
      scope: 'this-process JS network entry points',
      patched_apis: [],
      installed: false,
      uninstalled: false,
      limitations: GUARD_LIMITATIONS,
    },
    workload: null,
    static_network_import_scan: null,
    attempt_policy: {
      network_mode: 'none',
      registered_origins: [],
      rule: 'while network_mode is none with no registered origins, every attempted connection is an unregistered attempt and fails the smoke',
    },
    attempts: [],
    attempted_count: 0,
    registered_attempts: 0,
    unregistered_attempts: 0,
    exit_code: null,
    pass: false,
    limitations: [],
  };

  // source-lock: parse and report identity/adoption; never edit it.
  let lock = null;
  try {
    const lockText = readFileSync(SOURCE_LOCK_PATH, 'utf8');
    report.source_lock.exists = true;
    report.source_lock.sha256 = sha256Hex(lockText);
    const parsed = parseSourceLock(lockText);
    if (parsed.ok) {
      lock = parsed.lock;
      report.source_lock.parsed = true;
      report.source_lock.network_mode = lock.limits.network_mode;
      report.source_lock.remote_services = lock.limits.remote_services;
      report.source_lock.adopted_count = adoptionSummary(lock).adopted_count;
      report.source_lock.commands = lock.commands.length;
    } else {
      report.source_lock.errors = parsed.errors;
    }
  } catch (error) {
    report.source_lock.errors = [
      { path: '$.source_lock', keyword: 'missing', message: error instanceof Error ? error.code ?? error.message : String(error) },
    ];
  }
  if (!report.source_lock.parsed) {
    report.exit_code = EXIT.USAGE;
    report.limitations.push('source-lock.json missing or invalid; refusing to claim an outlet pass');
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return EXIT.USAGE;
  }
  if (lock.limits.network_mode !== 'none' || lock.limits.remote_services.length !== 0) {
    report.exit_code = EXIT.USAGE;
    report.limitations.push('source-lock limits do not declare network_mode=none with no remote services; refusing to pass');
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return EXIT.USAGE;
  }

  const keepArtifacts = argv.includes('--keep-artifacts');
  const outArg = argValue(argv, '--out');
  const outDir = outArg !== null ? path.resolve(outArg) : mkdtempSync(path.join(os.tmpdir(), 'dia-network-smoke-'));
  const ephemeralOut = outArg === null;
  report.workload = { out_dir: outDir, cleanup: ephemeralOut && !keepArtifacts ? 'removed' : 'kept' };

  // Install the guard BEFORE importing/executing the render workload.
  const guard = installNetworkGuard();
  report.guard.installed = true;
  report.guard.patched_apis = guard.patched_apis;
  report.attempts = guard.attempts;

  let workload = null;
  let exitCode = EXIT.PASS;
  try {
    workload = await runBuiltinWorkload({ projectRoot: PROJECT_ROOT, outDir });
  } catch (error) {
    workload = {
      renderer: 'builtin',
      seam: 'unhandled',
      status: 'failed',
      steps: [],
      modules: [],
      missing: [],
      errors: [{ path: 'workload', keyword: 'exception', message: error instanceof Error ? error.message : String(error) }],
    };
  } finally {
    guard.uninstall();
  }
  report.guard.uninstalled = guard.installed === false;
  report.workload = { ...report.workload, ...workload };
  report.renderers_run = workload.status === 'executed' ? ['builtin'] : [];

  // Source-lock adoption honesty in the smoke evidence too.
  report.source_lock.adoption = adoptionSummary(lock);

  // Guard outcome, independent of the workload.
  report.attempted_count = guard.attempts.length;
  // source-lock network_mode is none and remote_services is empty, so there is
  // no registered destination: every attempt is unregistered by definition.
  report.registered_attempts = 0;
  report.unregistered_attempts = guard.attempts.length;
  if (report.attempted_count > 0) {
    exitCode = EXIT.VERIFY_FAILED;
    report.limitations.push(`GUARD RECORDED ${report.attempted_count} network attempt(s); see attempts[] — this is a failure even though every attempt was blocked`);
  }

  if (workload.status === 'dependency_missing') {
    exitCode = EXIT.DEPENDENCY_MISSING;
    report.limitations.push('renderer dependency missing: builtin render workload could not be executed in-process; zero attempts from a skipped workload is NOT an outlet pass');
  } else if (workload.status !== 'executed') {
    if (exitCode === EXIT.PASS) exitCode = EXIT.VERIFY_FAILED;
  }
  if (workload.status === 'executed') {
    const dirty = report.renderers_requested.filter((renderer) => renderer !== 'builtin');
    if (dirty.length > 0) report.limitations.push(`requested renderer(s) not run and not claimed: ${dirty.join(', ')}`);
  }

  // Static complement scan over the modules the workload used.
  report.static_network_import_scan = staticNetworkImportScan(PROJECT_ROOT, workload.modules ?? []);
  if (report.static_network_import_scan.ok === false) {
    report.limitations.push('static scan found network-import statements in a render module; this is informational, the runtime guard is the authoritative attempt record');
  }

  // Limitations always printed in evidence.
  report.limitations.push(
    'Guard is a this-process JS audit boundary, not OS-level isolation; browser/CSP/native/other-process outlet remains a separate gate.',
    'Builtin renderer only: Atlas is investigation-only; Archify/Drawio have no adopted locked executor (source-lock.commands is empty) and were not executed.',
    'source-lock.json is Lead-owned and was read only; no adopted source bytes were verified by this tool (see tools/check-runtime.mjs for adopted-file verification).',
  );

  const pass =
    exitCode === EXIT.PASS &&
    report.attempted_count === 0 &&
    report.unregistered_attempts === 0 &&
    workload.status === 'executed' &&
    workload.verification?.ok === true &&
    report.guard.uninstalled === true;
  report.pass = pass;
  report.exit_code = exitCode;

  if (ephemeralOut && !keepArtifacts) {
    try {
      rmSync(outDir, { recursive: true, force: true });
    } catch {
      /* keep evidence; cleanup is best effort */
    }
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return exitCode;
}

process.exitCode = await main(process.argv.slice(2));
