/**
 * Shared helpers for the T5 document-store tests (tests/fixtures/store).
 *
 * Everything here writes only inside an explicit temporary root created with
 * `mkdtemp`; nothing touches DSH_HOME or real user files. The artifact package
 * mirror is built from the authoritative contracts + drawio exporter so the
 * document store consumes exactly the shape src/archive.mjs produces.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalJson, sha256Hex } from '../../../src/canonical.mjs';
import {
  emptyOverlay,
  specDigest,
  validateManifest,
  validateOverlay,
  validateComposite,
} from '../../../src/contracts.mjs';
import { exportDrawio } from '../../../src/drawio/xml.mjs';
import { createAccessRegistry } from '../../../src/editor/access.mjs';

export const FIXED_NOW = '2026-11-07T02:00:00.000Z';

/**
 * Create an isolated temporary root; the returned `cleanup` removes it.
 * @param {import('node:test').TestContext} t
 * @param {string} [prefix]
 * @returns {string}
 */
export function tempRoot(t, prefix = 'dsh-06-store-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    } catch {
      // Windows may keep transient handles; ignore cleanup failure in tests.
    }
  });
  return root;
}

/**
 * Minimal valid conceptual DiagramSpecV1 used as the base spec of an artifact.
 * @param {{diagram_id?:string, title?:string, now?:string}} [options]
 * @returns {any}
 */
export function conceptualSpec(options = {}) {
  const diagramId = options.diagram_id ?? 'diagram-demo-1';
  const now = options.now ?? FIXED_NOW;
  return {
    schema_version: 1,
    diagram_id: diagramId,
    revision: 0,
    mode: 'conceptual',
    title: options.title ?? 'Demo diagram',
    scope_ref: 'scope-demo',
    sources: [],
    nodes: [
      {
        id: 'n1',
        label: 'Node one',
        kind: 'module',
        origin: 'annotation',
        evidence_refs: [],
        description: null,
      },
      {
        id: 'n2',
        label: 'Node two',
        kind: 'module',
        origin: 'annotation',
        evidence_refs: [],
        description: null,
      },
    ],
    edges: [
      {
        id: 'e1',
        from: 'n1',
        to: 'n2',
        kind: 'annotation',
        certainty: 'unknown',
        origin: 'annotation',
        label: 'relates',
        evidence_refs: [],
        explanation: null,
      },
    ],
    layout: {
      algorithm: 'layered_v1',
      direction: 'LR',
      positions: [
        { node_id: 'n1', x: 40, y: 40, width: 160, height: 64 },
        { node_id: 'n2', x: 320, y: 40, width: 160, height: 64 },
      ],
    },
    coverage: {
      complete: false,
      truncated: false,
      omitted_nodes: 0,
      omitted_edges: 0,
      unresolved_count: 0,
      notes: [],
    },
    source_state: 'unknown',
    generated_at: now,
    renderer_ref: 'builtin:renderer-v1',
  };
}

/**
 * @param {any} spec
 * @param {{now?:string, items?:any[]}} [options]
 * @returns {any}
 */
export function overlayFor(spec, options = {}) {
  const overlay = emptyOverlay({
    diagram_id: spec.diagram_id,
    base_spec_digest: specDigest(spec),
    now: options.now ?? FIXED_NOW,
  });
  if (options.items !== undefined) overlay.items = options.items;
  const composite = validateComposite(spec, overlay);
  if (composite.ok !== true) {
    throw new Error(`helper overlay invalid: ${JSON.stringify(composite.errors)}`);
  }
  return overlay;
}

/**
 * Build a generated artifact package in `directory` with the same seven files
 * src/archive.mjs emits. The manifest is computed with the same rules as
 * `computeArtifactManifest` (no archive import needed).
 * @param {string} directory
 * @param {{spec?:any, overlay?:any, now?:string, artifactId?:string, rendererRef?:string}} [options]
 * @returns {{directory:string, spec:any, overlay:any, xml:string, manifest:any, files:Record<string,string|Buffer>}}
 */
export function buildArtifactPackage(directory, options = {}) {
  const spec = options.spec ?? conceptualSpec({ now: options.now ?? FIXED_NOW });
  const overlay = options.overlay ?? overlayFor(spec, { now: options.now ?? FIXED_NOW });
  const composite = validateComposite(spec, overlay);
  if (composite.ok !== true) throw new Error(`artifact overlay invalid: ${JSON.stringify(composite.errors)}`);
  const exported = exportDrawio({ spec, annotation_overlay: overlay });
  const xml = exported.xml;
  const now = options.now ?? FIXED_NOW;
  const artifactId = options.artifactId ?? 'artifact-0123456789abcdef01234567';
  const rendererRef = options.rendererRef ?? 'builtin:renderer-v1';
  const specContent = `${canonicalJson(spec)}\n`;
  const overlayContent = `${canonicalJson(overlay)}\n`;
  const contents = new Map([
    ['index.html', '<!doctype html><html><body><p>demo</p></body></html>\n'],
    ['diagram.svg', '<svg xmlns="http://www.w3.org/2000/svg"></svg>\n'],
    ['diagram-spec.json', specContent],
    ['annotations.json', overlayContent],
    ['diagram.drawio', xml],
    ['evidence.json', '{"nodes":[],"edges":[]}\n'],
  ]);
  const files = [];
  for (const [relativePath, content] of contents) {
    const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    files.push({
      relative_path: relativePath,
      media_type: mediaTypeFor(relativePath),
      sha256: sha256Hex(bytes),
      size: bytes.length,
    });
  }
  files.sort((left, right) => (left.relative_path < right.relative_path ? -1 : 1));
  const manifest = {
    schema_version: 1,
    artifact_id: artifactId,
    diagram_id: spec.diagram_id,
    spec_digest: specDigest(spec),
    source_digests: [],
    renderer_ref: rendererRef,
    created_at: now,
    files,
    network_mode: 'offline',
    source_state: spec.source_state,
  };
  const manifestCheck = validateManifest(manifest);
  if (manifestCheck.ok !== true) {
    throw new Error(`helper manifest invalid: ${JSON.stringify(manifestCheck.errors)}`);
  }
  fs.mkdirSync(directory, { recursive: true });
  for (const [relativePath, content] of contents) {
    fs.writeFileSync(path.join(directory, relativePath), content);
  }
  fs.writeFileSync(path.join(directory, 'manifest.json'), `${canonicalJson(manifest)}\n`);
  return { directory, spec, overlay, xml, manifest, files: Object.fromEntries(contents) };
}

/** @param {string} relativePath @returns {string} */
function mediaTypeFor(relativePath) {
  if (relativePath.endsWith('.json')) return 'application/json';
  if (relativePath.endsWith('.html')) return 'text/html';
  if (relativePath.endsWith('.svg')) return 'image/svg+xml';
  if (relativePath.endsWith('.drawio')) return 'application/vnd.jgraph.mxfile';
  return 'application/octet-stream';
}

/**
 * Build a registry with one context, one output root (the temp root) and one
 * document (the artifact directory below it).
 *
 * @param {{root:string, artifact_directory:string, scope_ref?:string, scope_generation?:number, document_ref?:string, document_id?:string, mode?:'read'|'edit'}} input
 * @returns {any}
 */
export function testRegistry(input) {
  const scopeRef = input.scope_ref ?? 'scope-demo';
  const scopeGeneration = input.scope_generation ?? 0;
  const registry = createAccessRegistry();
  const context = registry.registerContext({
    context_ref: 'ctx-demo',
    scope_ref: scopeRef,
    scope_generation: scopeGeneration,
  });
  if (context.ok !== true) throw new Error(`registerContext failed: ${JSON.stringify(context)}`);
  const outputRoot = registry.registerOutputRoot({
    output_ref: 'out-demo',
    scope_ref: scopeRef,
    scope_generation: scopeGeneration,
    path: input.root,
  });
  if (outputRoot.ok !== true) throw new Error(`registerOutputRoot failed: ${JSON.stringify(outputRoot)}`);
  const document = registry.registerDocument({
    document_ref: input.document_ref ?? 'doc-demo',
    document_id: input.document_id ?? 'doc-001',
    scope_ref: scopeRef,
    scope_generation: scopeGeneration,
    path: input.artifact_directory,
    mode: input.mode ?? 'edit',
  });
  if (document.ok !== true) throw new Error(`registerDocument failed: ${JSON.stringify(document)}`);
  return registry;
}

/** @param {string} [principalId] @returns {{principal:{kind:'owner', principal_id:string}}} */
export function ownerCaller(principalId = 'owner-1') {
  return { principal: { kind: 'owner', principal_id: principalId } };
}

/** @param {{scope_ref?:string, scope_generation?:number}} [scope] */
export function scopedCaller(scope = {}) {
  return {
    principal: { kind: 'owner', principal_id: 'owner-1' },
    scope_generation: scope.scope_generation,
    context: scope.scope_ref === undefined ? undefined : { scope_ref: scope.scope_ref, scope_generation: scope.scope_generation },
  };
}

/**
 * Controllable clock. `clock()` returns the current fake time as ISO text.
 * @param {string} [startIso]
 * @returns {{clock:() => string, set:(iso:string) => void, advance:(ms:number) => void, now:() => string}}
 */
export function fakeClock(startIso = FIXED_NOW) {
  let current = Date.parse(startIso);
  return {
    clock: () => new Date(current).toISOString(),
    set: (iso) => {
      current = Date.parse(iso);
    },
    advance: (ms) => {
      current += ms;
    },
    now: () => new Date(current).toISOString(),
  };
}

/**
 * Wrap node:fs so tests can inject crash points / ENOSPC. Hooks match the
 * operation name and (optionally) a substring of the first path argument.
 *
 * @param {Array<{op:string, pathIncludes?:string, occurrence?:number, code?:string}>} hooks
 * @returns {any}
 */
export function crashyFs(hooks = []) {
  const preparedHooks = hooks.map((hook) => ({ ...hook, seen: 0 }));
  return new Proxy(fs, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      return function wrapped(...args) {
        const firstPath = typeof args[0] === 'string' ? args[0] : '';
        for (const hook of preparedHooks) {
          if (hook.op !== String(property)) continue;
          if (hook.pathIncludes && !firstPath.includes(hook.pathIncludes)) continue;
          hook.seen += 1;
          if (hook.occurrence && hook.occurrence !== hook.seen) continue;
          const error = new Error(`SIMULATED_CRASH:${String(property)}`);
          error.code = hook.code ?? 'SIMULATED_CRASH';
          throw error;
        }
        return value.apply(target, args);
      };
    },
  });
}

/**
 * Wrap node:fs so one specific write fails like a full disk, optionally only
 * from the Nth matching call onwards (so the bootstrap writes can succeed).
 * @param {{op?:string, pathIncludes?:string, fromOccurrence?:number}} trigger
 * @returns {any}
 */
export function fullDiskFs(trigger = {}) {
  const op = trigger.op ?? 'writeFileSync';
  const pathIncludes = trigger.pathIncludes ?? 'revisions';
  const fromOccurrence = trigger.fromOccurrence ?? 1;
  let matches = 0;
  return new Proxy(fs, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      return function wrapped(...args) {
        const firstPath = typeof args[0] === 'string' ? args[0] : '';
        if (String(property) === op && firstPath.includes(pathIncludes)) {
          matches += 1;
          if (matches >= fromOccurrence) {
            const error = new Error('ENOSPC: no space left on device (simulated)');
            error.code = 'ENOSPC';
            throw error;
          }
        }
        return value.apply(target, args);
      };
    },
  });
}

/** @param {string} file @returns {any} */
export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** @param {string} file @returns {boolean} */
export function exists(file) {
  return fs.existsSync(file);
}

/**
 * @param {string} dataRoot
 * @param {string} documentId
 * @returns {{pointer:any|null, journal:any[]}}
 */
export function readStoreState(dataRoot, documentId) {
  const directory = path.join(dataRoot, 'documents', documentId);
  const pointerFile = path.join(directory, 'pointer.json');
  const journalFile = path.join(directory, 'journal.jsonl');
  const pointer = fs.existsSync(pointerFile) ? readJson(pointerFile) : null;
  const journal = fs.existsSync(journalFile)
    ? fs
        .readFileSync(journalFile, 'utf8')
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line))
    : [];
  return { pointer, journal };
}

/**
 * @param {string} dataRoot
 * @param {string} documentId
 * @returns {string[]} revision base names (generation-sha) without extension
 */
export function revisionNames(dataRoot, documentId) {
  const directory = path.join(dataRoot, 'documents', documentId, 'revisions');
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory)
    .filter((name) => name.endsWith('.drawio'))
    .map((name) => name.slice(0, -'.drawio'.length))
    .sort();
}

/** @param {string} text @returns {string} */
export function sha256(text) {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

/**
 * Produce XML for a base spec + overlay exactly as the store's canonical form.
 * @param {any} spec
 * @param {any} overlay
 * @returns {string}
 */
export function canonicalXml(spec, overlay) {
  return exportDrawio({ spec, annotation_overlay: overlay }).xml;
}

/** @param {any} overlay @returns {any} deep copy */
export function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/** Ensure the overlay validates (throws otherwise) and return it. */
export function validOverlay(spec, overlay) {
  const overlayCheck = validateOverlay(overlay);
  if (overlayCheck.ok !== true) throw new Error(`overlay invalid: ${JSON.stringify(overlayCheck.errors)}`);
  const composite = validateComposite(spec, overlay);
  if (composite.ok !== true) throw new Error(`composite invalid: ${JSON.stringify(composite.errors)}`);
  return overlay;
}
