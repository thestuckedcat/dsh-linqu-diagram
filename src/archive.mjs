/**
 * 06 local diagrams — atomic artifact archive (DIA-04).
 *
 * Frozen interface (docs/interfaces.md §5):
 *   renderLocal({spec, overlay, output_ref, renderer, expected_output_revision,
 *                operation_id}, caller, signal)
 *     -> {status:'saved', artifact_ref, manifest_digest} |
 *        {status:'conflict'|'denied'|'cancelled'|'failed'|'outcome_unknown', code}
 *   computeArtifactManifest({artifact_id, spec, overlay, files, renderer_ref, created_at})
 *   artifactFileNames()
 *
 * Transaction model (design §5):
 *  1. all bytes are rendered/validated in memory first (a render failure never
 *     creates staging);
 *  2. `<root>/<output_ref>/.staging/<operation_id>/` is written file-by-file
 *     with per-file fsync, manifest.json last, then the directory is fsynced;
 *  3. the staging directory is renamed on the same volume to the immutable
 *     `<root>/<output_ref>/<artifact_id>/` directory (never overwritten);
 *  4. an operation record is written atomically so a repeated operation returns
 *     the same artifact (identical spec/overlay/renderer) and a different
 *     payload under the same operation_id is a conflict.
 *
 * Dependency injection is construction-time only (createArchive): the default
 * module-level renderLocal lazily imports the real drawio exporter and uses the
 * real filesystem. Tests may inject an exporter/io/clock factory; a tool or RPC
 * caller may NOT supply these through the request/caller objects.
 */
import path from 'node:path';
import { digestOf, sha256Hex, canonicalJson } from './canonical.mjs';
import { DiagramError } from './errors.mjs';
import { LIMITS } from './limits.mjs';
import { layoutDiagram } from './layout.mjs';
import { renderSvg } from './render-svg.mjs';
import { renderHtml } from './render-html.mjs';
import {
  validateDiagramSpec,
  validateOverlay,
  validateComposite,
  validateManifest,
  specDigest,
  overlayDigest,
  manifestDigest,
  emptyOverlay,
} from './contracts.mjs';

/** The immutable artifact package file list (design §4/§5). */
const ARTIFACT_FILE_NAMES = Object.freeze([
  'index.html',
  'diagram.svg',
  'diagram-spec.json',
  'manifest.json',
  'evidence.json',
  'diagram.drawio',
  'annotations.json',
]);

const PAYLOAD_MEDIA_TYPES = Object.freeze({
  'index.html': 'text/html',
  'diagram.svg': 'image/svg+xml',
  'diagram-spec.json': 'application/json',
  'manifest.json': 'application/json',
  'evidence.json': 'application/json',
  'diagram.drawio': 'application/xml',
  'annotations.json': 'application/json',
});

const ARTIFACT_ID_PATTERN = /^artifact-[0-9a-f]{24}$/;
const OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/;
const OUTPUT_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** @returns {string[]} the fixed artifact package file names */
export function artifactFileNames() {
  return [...ARTIFACT_FILE_NAMES];
}

/** @param {unknown} value @returns {boolean} */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** @param {string} text @returns {string} */
function newline(text) {
  return `${text}\n`;
}

/** @param {string} name */
function mediaTypeForArtifact(name) {
  const mediaType = PAYLOAD_MEDIA_TYPES[name];
  if (!mediaType) throw new DiagramError('INTERNAL_FAILURE', `unknown artifact file: ${name}`);
  return mediaType;
}

/**
 * Build the structural evidence index written to evidence.json. It mirrors the
 * spec so every node/edge keeps its evidence refs and certainty; it never adds
 * or upgrades evidence.
 * @param {any} spec
 * @param {string} specDigestValue
 */
function buildEvidenceIndex(spec, specDigestValue) {
  const nodes = (spec.nodes ?? [])
    .map((node) => ({
      id: node.id,
      label: node.label,
      kind: node.kind,
      origin: node.origin,
      evidence_refs: Array.isArray(node.evidence_refs) ? node.evidence_refs : [],
    }))
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const edges = (spec.edges ?? [])
    .map((edge) => ({
      id: edge.id,
      from: edge.from,
      to: edge.to,
      kind: edge.kind,
      certainty: edge.certainty,
      origin: edge.origin,
      label: edge.label,
      evidence_refs: Array.isArray(edge.evidence_refs) ? edge.evidence_refs : [],
      explanation: edge.explanation ?? null,
    }))
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  return {
    schema_version: 1,
    diagram_id: spec.diagram_id,
    spec_digest: specDigestValue,
    generated_at: spec.generated_at,
    source_state: spec.source_state,
    mode: spec.mode,
    sources: Array.isArray(spec.sources) ? spec.sources : [],
    nodes,
    edges,
    coverage: isPlainObject(spec.coverage) ? spec.coverage : {},
  };
}

/**
 * Compute an ArtifactManifestV1 from the generated file contents. The manifest
 * describes the six payload files; manifest.json itself is not self-hashed
 * (it cannot contain its own digest) and is the seventh package file.
 * @param {{artifact_id:string, spec:any, overlay:any, files:{relative_path:string,content:string|Uint8Array}[], renderer_ref:string, created_at:string}} input
 * @returns {object}
 */
export function computeArtifactManifest(input) {
  const { artifact_id, spec, files, renderer_ref, created_at } = input ?? {};
  if (typeof artifact_id !== 'string' || !ARTIFACT_ID_PATTERN.test(artifact_id)) {
    throw new DiagramError('INVALID_INPUT', 'artifact_id must match artifact-<24 lowercase hex>');
  }
  if (!isPlainObject(spec)) throw new DiagramError('INVALID_INPUT', 'spec must be an object');
  if (typeof renderer_ref !== 'string' || renderer_ref.length === 0) {
    throw new DiagramError('INVALID_INPUT', 'renderer_ref must be a non-empty string');
  }
  if (typeof created_at !== 'string' || created_at.length === 0) {
    throw new DiagramError('INVALID_INPUT', 'created_at must be a non-empty string');
  }
  if (!Array.isArray(files)) throw new DiagramError('INVALID_INPUT', 'files must be an array');
  const manifestFiles = files
    .map((file) => {
      if (!isPlainObject(file) || typeof file.relative_path !== 'string') {
        throw new DiagramError('INVALID_INPUT', 'each generated file needs relative_path and content');
      }
      if (file.relative_path === 'manifest.json') {
        throw new DiagramError('INVALID_INPUT', 'manifest.json cannot hash itself');
      }
      const content = file.content;
      const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
      if (!(bytes instanceof Uint8Array)) {
        throw new DiagramError('INVALID_INPUT', 'file content must be a string or Uint8Array');
      }
      return {
        relative_path: file.relative_path,
        media_type: file.media_type ?? mediaTypeForArtifact(file.relative_path),
        sha256: sha256Hex(bytes),
        size: bytes.byteLength,
      };
    })
    .sort((left, right) => (left.relative_path < right.relative_path ? -1 : left.relative_path > right.relative_path ? 1 : 0));
  const sourceDigests = (Array.isArray(spec.sources) ? spec.sources : [])
    .map((source) => ({
      source_id: source.source_id,
      digest: sha256Hex(canonicalJson(source)),
    }))
    .sort((left, right) => (left.source_id < right.source_id ? -1 : left.source_id > right.source_id ? 1 : 0));
  return {
    schema_version: 1,
    artifact_id,
    diagram_id: spec.diagram_id,
    spec_digest: specDigest(spec),
    source_digests: sourceDigests,
    renderer_ref,
    created_at,
    files: manifestFiles,
    network_mode: 'offline',
    source_state: spec.source_state,
  };
}

/** Default durable filesystem operations (fsync per file, fsync directory where supported). */
function createDefaultIo() {
  /** @param {string} filePath */
  async function fsyncDirectory(directoryPath) {
    // Directory fsync is not supported on every platform/filesystem; file
    // fsync above is the durability guarantee, directory fsync is best effort.
    try {
      const { open } = await import('node:fs/promises');
      const handle = await open(directoryPath, 'r');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch {
      /* platform does not allow fsync on directories */
    }
  }
  return {
    mkdir: async (directoryPath, options) => {
      const { mkdir } = await import('node:fs/promises');
      await mkdir(directoryPath, options);
    },
    readFile: async (filePath) => {
      const { readFile } = await import('node:fs/promises');
      return readFile(filePath, 'utf8');
    },
    readdir: async (directoryPath) => {
      const { readdir } = await import('node:fs/promises');
      return readdir(directoryPath);
    },
    stat: async (targetPath) => {
      const { stat } = await import('node:fs/promises');
      return stat(targetPath);
    },
    realpath: async (targetPath) => {
      const { realpath } = await import('node:fs/promises');
      return realpath(targetPath);
    },
    rm: async (targetPath, options) => {
      const { rm } = await import('node:fs/promises');
      await rm(targetPath, options);
    },
    rename: async (from, to) => {
      const { rename } = await import('node:fs/promises');
      await rename(from, to);
    },
    writeFileDurable: async (filePath, data) => {
      const { open } = await import('node:fs/promises');
      const handle = await open(filePath, 'w');
      try {
        await handle.writeFile(data);
        await handle.sync();
      } finally {
        await handle.close();
      }
    },
    fsyncDir: fsyncDirectory,
  };
}

/** Lazily import the restricted drawio exporter owned by T4. */
async function importDrawioExporter() {
  try {
    const module = await import('./drawio/xml.mjs');
    if (typeof module.exportDrawio !== 'function') return null;
    return module.exportDrawio;
  } catch {
    return null;
  }
}

const DEFAULT_DEPS = {
  exportDrawio: null,
  io: null,
  clock: null,
  limits: LIMITS,
  authorizeOutputRoot: null,
};

/**
 * Create an archive implementation with construction-time dependencies. The
 * default (module-level) renderLocal wraps these defaults plus the real drawio
 * exporter.
 * @param {{exportDrawio?:Function|null, io?:object|null, clock?:Function|null, limits?:object, authorizeOutputRoot?:Function|null}} [options]
 */
export function createArchive(options = {}) {
  const deps = {
    exportDrawio: options.exportDrawio ?? null,
    io: { ...createDefaultIo(), ...(options.io ?? {}) },
    clock: options.clock ?? (() => new Date().toISOString()),
    limits: { ...LIMITS, ...(options.limits ?? {}) },
    authorizeOutputRoot: options.authorizeOutputRoot ?? null,
  };
  return {
    renderLocal: (request, caller, signal) => renderLocalImpl(request, caller, signal, deps),
    computeArtifactManifest,
    artifactFileNames,
  };
}

/**
 * Default module-level entry: real filesystem, real clock, real drawio exporter
 * (lazily imported; the archive reports `UNSUPPORTED` when it is unavailable).
 * @param {object} request
 * @param {object} caller
 * @param {AbortSignal} [signal]
 */
export async function renderLocal(request, caller, signal) {
  const deps = {
    exportDrawio: null,
    io: createDefaultIo(),
    clock: () => new Date().toISOString(),
    limits: LIMITS,
    authorizeOutputRoot: null,
  };
  return renderLocalImpl(request, caller, signal, deps);
}

/** @param {AbortSignal|undefined} signal */
function isCancelled(signal) {
  return Boolean(signal && signal.aborted === true);
}

/** @param {AbortSignal|undefined} signal */
function throwIfCancelled(signal) {
  if (isCancelled(signal)) throw new DiagramError('CANCELLED', 'operation cancelled');
}

/** @param {object} io @param {string} targetPath */
async function pathExists(io, targetPath) {
  try {
    await io.stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

/** @param {object} io @param {string} targetPath */
async function safeRemove(io, targetPath) {
  try {
    await io.rm(targetPath, { recursive: true, force: true });
  } catch {
    /* cleanup is best effort; a half staging dir is never exposed as an artifact */
  }
}

/** @param {unknown} code @param {string} message */
function failed(code, message) {
  return { status: 'failed', code };
}

/**
 * Sanitize an operation id into a directory name (already pattern-validated).
 * @param {string} operationId
 */
function operationDirectory(operationId) {
  return operationId;
}

/** @param {string} value @returns {boolean} */
function isSafeOutputRef(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  const segments = value.split('/');
  if (segments.length > 8) return false;
  return segments.every((segment) => OUTPUT_SEGMENT_PATTERN.test(segment) && segment !== '.' && segment !== '..');
}

/**
 * @param {object} deps
 * @param {string} rootRealPath
 * @param {string} outputRef
 * @param {string} operationId
 * @param {AbortSignal|undefined} signal
 */
async function renderLocalImpl(request, caller, signal, deps) {
  try {
    return await renderLocalTransaction(request, caller, signal, deps);
  } catch (error) {
    if (error instanceof DiagramError) {
      if (error.code === 'CANCELLED') return { status: 'cancelled', code: 'CANCELLED' };
      if (error.code === 'LIMIT_EXCEEDED') return failed('LIMIT_EXCEEDED');
      if (error.code === 'INVALID_SPEC') return failed('INVALID_SPEC');
      if (error.code === 'INVALID_OVERLAY') return failed('INVALID_OVERLAY');
      if (error.code === 'INVALID_INPUT') return failed('INVALID_INPUT');
      if (error.code === 'UNSUPPORTED') return failed('UNSUPPORTED');
      return failed('FAILED');
    }
    if (isCancelled(signal)) return { status: 'cancelled', code: 'CANCELLED' };
    return failed('FAILED');
  }
}

/** @param {object} request @param {object} caller @param {AbortSignal|undefined} signal @param {object} deps */
async function renderLocalTransaction(request, caller, signal, deps) {
  const { io, clock, limits } = deps;
  if (!isPlainObject(request)) throw new DiagramError('INVALID_INPUT', 'request must be an object');
  const { spec, overlay: requestedOverlay } = request;
  const operationId = request.operation_id;
  const outputRef = request.output_ref;
  const renderer = request.renderer ?? 'builtin';
  const expectedOutputRevision = request.expected_output_revision ?? null;
  if (typeof operationId !== 'string' || !OPERATION_ID_PATTERN.test(operationId)) {
    throw new DiagramError('INVALID_INPUT', 'operation_id is required and must be a safe identifier');
  }
  if (!isSafeOutputRef(outputRef)) throw new DiagramError('INVALID_INPUT', 'output_ref must be a safe relative directory reference');
  if (renderer !== 'builtin') {
    // Atlas reuse / Archify executor are separate gated tasks (T3); only the
    // builtin renderer is implemented here.
    throw new DiagramError('UNSUPPORTED', `renderer ${renderer} is not implemented in this component`);
  }
  if (expectedOutputRevision !== null) {
    if (!Number.isSafeInteger(expectedOutputRevision) || expectedOutputRevision < 0) {
      throw new DiagramError('INVALID_INPUT', 'expected_output_revision must be a non-negative integer or null');
    }
  }
  // Trusted caller grant: the CLI/Host builds this object at the trust boundary.
  if (!isPlainObject(caller) || caller.granted !== true || typeof caller.granted_output_root !== 'string' || caller.granted_output_root.length === 0) {
    return { status: 'denied', code: 'DENIED' };
  }
  if (!isPlainObject(spec)) throw new DiagramError('INVALID_SPEC', 'spec must be an object');
  if (isCancelled(signal)) return { status: 'cancelled', code: 'CANCELLED' };

  const specCheck = validateDiagramSpec(spec);
  if (!specCheck.ok) throw new DiagramError('INVALID_SPEC', 'spec failed validation');
  const validatedSpec = specCheck.value ?? spec;
  const specDigestValue = specDigest(validatedSpec);
  // Provenance: the artifact may only claim the renderer that actually produced
  // it. A spec generated for another renderer family cannot be packaged here.
  if (typeof validatedSpec.renderer_ref !== 'string' || !validatedSpec.renderer_ref.startsWith(`${renderer}:`)) {
    throw new DiagramError('UNSUPPORTED', 'spec renderer_ref does not match the requested renderer');
  }
  if (expectedOutputRevision !== null && validatedSpec.revision !== expectedOutputRevision) {
    return { status: 'conflict', code: 'STALE_VERSION' };
  }

  /** @type {any} */
  let overlay;
  if (requestedOverlay === null || requestedOverlay === undefined) {
    overlay = emptyOverlay({
      diagram_id: validatedSpec.diagram_id,
      base_spec_digest: specDigestValue,
      now: clock(),
    });
  } else {
    overlay = requestedOverlay;
  }
  const overlayCheck = validateOverlay(overlay);
  if (!overlayCheck.ok) throw new DiagramError('INVALID_OVERLAY', 'overlay failed validation');
  const validatedOverlay = overlayCheck.value ?? overlay;
  if (validatedOverlay.diagram_id !== validatedSpec.diagram_id || validatedOverlay.base_spec_digest !== specDigestValue) {
    throw new DiagramError('INVALID_OVERLAY', 'overlay does not belong to this spec');
  }
  const compositeCheck = validateComposite(validatedSpec, validatedOverlay);
  if (!compositeCheck.ok) throw new DiagramError('INVALID_OVERLAY', 'spec/overlay composite failed validation');
  const overlayDigestValue = overlayDigest(validatedOverlay);

  // Artifact identity is semantic: contract spec digest (runtime timestamps
  // excluded), source_state (a stale re-render must not reuse a current
  // package), overlay digest and renderer. A repeated operation for identical
  // semantic input therefore reuses the immutable artifact; different content
  // under one operation id is a conflict.
  const semanticDigestValue = digestOf({
    spec_digest: specDigestValue,
    source_state: validatedSpec.source_state,
    overlay_digest: overlayDigestValue,
    renderer_ref: validatedSpec.renderer_ref,
  });
  const artifactId = `artifact-${semanticDigestValue.slice(0, 24)}`;
  if (!ARTIFACT_ID_PATTERN.test(artifactId)) throw new DiagramError('INTERNAL_FAILURE', 'artifact id generation failed');

  // Resolve/create the granted output root, then apply the construction-time
  // registry authorization seam (later: access.mjs lookupOutputRoot + identity).
  const rootPath = path.resolve(caller.granted_output_root);
  await io.mkdir(rootPath, { recursive: true });
  const rootRealPath = await io.realpath(rootPath);
  if (typeof deps.authorizeOutputRoot === 'function') {
    const authorized = await deps.authorizeOutputRoot(rootRealPath, caller);
    if (authorized !== true) return { status: 'denied', code: 'DENIED' };
  }
  const collectionDir = path.join(rootRealPath, outputRef);
  const stagingRoot = path.join(collectionDir, '.staging');
  const stagingDir = path.join(stagingRoot, operationDirectory(operationId));
  const finalDir = path.join(collectionDir, artifactId);
  const operationsDir = path.join(rootRealPath, '.operations');
  const operationRecordPath = path.join(operationsDir, `${operationId}.json`);

  // Idempotency: an operation id belongs to exactly one payload.
  const payloadIdentity = {
    semantic_digest: semanticDigestValue,
    renderer_ref: validatedSpec.renderer_ref,
  };
  const existingOperation = await readOperationRecord(io, operationRecordPath);
  // Records written by earlier artifact-identity layouts are ignored (the new
  // immutable layout is rebuilt and the record is replaced) instead of being
  // reported as a false conflict.
  const legacyOperation =
    existingOperation !== null &&
    isPlainObject(existingOperation.payload_identity) &&
    !Object.prototype.hasOwnProperty.call(existingOperation.payload_identity, 'semantic_digest');
  if (existingOperation !== null && !legacyOperation) {
    if (existingOperation.payload_identity !== undefined) {
      if (!sameJson(existingOperation.payload_identity, payloadIdentity)) {
        return { status: 'conflict', code: 'CONFLICT' };
      }
    }
    if (Array.isArray(existingOperation.artifact_file_names) && existingOperation.artifact_file_names.length === ARTIFACT_FILE_NAMES.length) {
      if (existingOperation.artifact_id !== artifactId) return { status: 'conflict', code: 'CONFLICT' };
      const existing = await inspectExistingArtifact(io, finalDir);
      if (existing.status === 'saved') return existing.result;
      return { status: 'conflict', code: 'CONFLICT' };
    }
  }

  const existing = await inspectExistingArtifact(io, finalDir);
  if (existing.status === 'saved') {
    await writeOperationRecord(io, operationsDir, operationRecordPath, {
      schema_version: 1,
      operation_id: operationId,
      artifact_id: artifactId,
      artifact_ref: joinRelative(outputRef, artifactId),
      payload_identity: payloadIdentity,
      manifest_digest: existing.result.manifest_digest,
      artifact_file_names: ARTIFACT_FILE_NAMES,
      created_at: clock(),
    });
    return existing.result;
  }
  if (existing.status === 'corrupt') return { status: 'outcome_unknown', code: 'OUTCOME_UNKNOWN' };

  // ---- Render everything in memory first (no staging on render failure). ----
  const layoutResult = layoutDiagram(validatedSpec, { direction: validatedSpec.layout?.direction === 'TB' ? 'TB' : 'LR' });
  const svgResult = renderSvg(validatedSpec, { overlay: validatedOverlay, layout: layoutResult });
  const createdAt = clock();
  const manifestPreview = { artifact_id: artifactId, spec_digest: specDigestValue };
  const htmlResult = renderHtml({
    spec: validatedSpec,
    overlay: validatedOverlay,
    layout: layoutResult,
    svg: svgResult.svg,
    text_equivalent: svgResult.text_equivalent,
    legend: svgResult.legend,
    hidden: svgResult.hidden,
    manifest: manifestPreview,
    renderer_ref: validatedSpec.renderer_ref,
    source_state: validatedSpec.source_state,
  });
  if (typeof deps.exportDrawio !== 'function') deps.exportDrawio = await importDrawioExporter();
  if (typeof deps.exportDrawio !== 'function') throw new DiagramError('UNSUPPORTED', 'drawio exporter is unavailable');
  const drawioResult = await deps.exportDrawio({ spec: validatedSpec, annotation_overlay: validatedOverlay });
  if (!isPlainObject(drawioResult) || typeof drawioResult.xml !== 'string' || drawioResult.xml.length === 0) {
    throw new DiagramError('INTERNAL_FAILURE', 'drawio exporter returned no XML');
  }
  const evidenceIndex = buildEvidenceIndex(validatedSpec, specDigestValue);
  const payloadFiles = [
    { relative_path: 'index.html', media_type: 'text/html', content: htmlResult.html },
    { relative_path: 'diagram.svg', media_type: 'image/svg+xml', content: svgResult.svg },
    { relative_path: 'diagram-spec.json', media_type: 'application/json', content: newline(canonicalJson(validatedSpec)) },
    { relative_path: 'evidence.json', media_type: 'application/json', content: newline(canonicalJson(evidenceIndex)) },
    { relative_path: 'diagram.drawio', media_type: 'application/xml', content: drawioResult.xml },
    { relative_path: 'annotations.json', media_type: 'application/json', content: newline(canonicalJson(validatedOverlay)) },
  ];
  const payloadBytes = payloadFiles.reduce((total, file) => total + Buffer.byteLength(file.content, 'utf8'), 0);
  if (payloadBytes > limits.package_bytes) throw new DiagramError('LIMIT_EXCEEDED', 'package exceeds size limit');
  const manifest = computeArtifactManifest({
    artifact_id: artifactId,
    spec: validatedSpec,
    overlay: validatedOverlay,
    files: payloadFiles,
    renderer_ref: validatedSpec.renderer_ref,
    created_at: createdAt,
  });
  const manifestCheck = validateManifest(manifest);
  if (!manifestCheck.ok) throw new DiagramError('INVALID_MANIFEST', 'computed artifact manifest failed validation');
  const manifestDigestValue = manifestDigest(manifest);
  const manifestContent = newline(canonicalJson(manifest));
  const packageBytes = payloadBytes + Buffer.byteLength(manifestContent, 'utf8');
  if (packageBytes > limits.package_bytes) throw new DiagramError('LIMIT_EXCEEDED', 'package exceeds size limit');
  const packageFiles = [
    ...payloadFiles,
    { relative_path: 'manifest.json', media_type: 'application/json', content: manifestContent },
  ];

  throwIfCancelled(signal);

  // ---- Staging: durable writes, manifest last, then atomic same-volume rename. ----
  await io.mkdir(stagingRoot, { recursive: true });
  const stagingExisted = await pathExists(io, stagingDir);
  if (stagingExisted) {
    // Leftover from a crash: if it is already a complete package and the final
    // directory is absent, finish the commit; otherwise clean it and retry.
    const recovered = await tryRecoverStaging(io, stagingDir, finalDir);
    if (recovered) {
      const recoveredManifest = await readManifest(io, path.join(finalDir, 'manifest.json'));
      if (recoveredManifest !== null) {
        const recoveredDigest = manifestDigest(recoveredManifest.manifest);
        await writeOperationRecord(io, operationsDir, operationRecordPath, {
          schema_version: 1,
          operation_id: operationId,
          artifact_id: artifactId,
          artifact_ref: joinRelative(outputRef, artifactId),
          payload_identity: payloadIdentity,
          manifest_digest: recoveredDigest,
          artifact_file_names: ARTIFACT_FILE_NAMES,
          created_at: clock(),
        });
        return { status: 'saved', artifact_ref: finalDir, manifest_digest: recoveredDigest };
      }
    }
    await safeRemove(io, stagingDir);
  }
  await io.mkdir(stagingDir, { recursive: true });
  try {
    for (const file of packageFiles) {
      throwIfCancelled(signal);
      await io.writeFileDurable(path.join(stagingDir, file.relative_path), file.content);
    }
    throwIfCancelled(signal);
    await io.fsyncDir(stagingDir);
    throwIfCancelled(signal);
    try {
      await io.rename(stagingDir, finalDir);
    } catch (renameError) {
      // A concurrent identical commit may have won the rename; never overwrite
      // an existing immutable directory.
      const raced = await inspectExistingArtifact(io, finalDir);
      if (raced.status !== 'saved') throw renameError;
      await safeRemove(io, stagingDir);
      await writeOperationRecord(io, operationsDir, operationRecordPath, {
        schema_version: 1,
        operation_id: operationId,
        artifact_id: artifactId,
        artifact_ref: joinRelative(outputRef, artifactId),
        payload_identity: payloadIdentity,
        manifest_digest: raced.result.manifest_digest,
        artifact_file_names: ARTIFACT_FILE_NAMES,
        created_at: clock(),
      });
      return raced.result;
    }
    await io.fsyncDir(collectionDir);
    const cancelledAfterCommit = isCancelled(signal);
    await writeOperationRecord(io, operationsDir, operationRecordPath, {
      schema_version: 1,
      operation_id: operationId,
      artifact_id: artifactId,
      artifact_ref: joinRelative(outputRef, artifactId),
      payload_identity: payloadIdentity,
      manifest_digest: manifestDigestValue,
      artifact_file_names: ARTIFACT_FILE_NAMES,
      created_at: clock(),
    });
    return {
      status: 'saved',
      artifact_ref: finalDir,
      manifest_digest: manifestDigestValue,
      ...(cancelledAfterCommit ? { cancelled_after_commit: true } : {}),
    };
  } catch (error) {
    await safeRemove(io, stagingDir);
    throw error;
  }
}

/**
 * Verify an existing package's payload bytes against its own manifest.
 * Review R-11: a directory with the right file names but replaced bytes must
 * never be reported as `saved` or recovered by rename.
 * @param {object} io
 * @param {string} directory
 * @param {any} manifest
 * @returns {Promise<boolean>}
 */
async function verifyArtifactBytes(io, directory, manifest) {
  const files = Array.isArray(manifest?.files) ? manifest.files : [];
  if (files.length === 0) return false;
  for (const file of files) {
    if (file === null || typeof file !== 'object' || typeof file.relative_path !== 'string') return false;
    let text;
    try {
      text = await io.readFile(path.join(directory, file.relative_path));
    } catch {
      return false;
    }
    const bytes = Buffer.from(text, 'utf8');
    if (typeof file.size === 'number' && bytes.byteLength !== file.size) return false;
    if (typeof file.sha256 === 'string' && sha256Hex(bytes) !== file.sha256) return false;
  }
  return true;
}

/**
 * Inspect an existing immutable artifact directory.
 * @param {object} io
 * @param {string} finalDir
 * @returns {{status:'absent'|'corrupt'|'saved', result?:object}}
 */
async function inspectExistingArtifact(io, finalDir) {
  if (!(await pathExists(io, finalDir))) return { status: 'absent' };
  const manifest = await readManifest(io, path.join(finalDir, 'manifest.json'));
  if (manifest === null) return { status: 'corrupt' };
  const fileNames = new Set();
  for (const file of manifest.manifest.files ?? []) fileNames.add(file.relative_path);
  const expected = ARTIFACT_FILE_NAMES.filter((name) => name !== 'manifest.json');
  for (const name of expected) {
    if (!fileNames.has(name)) return { status: 'corrupt' };
    if (!(await pathExists(io, path.join(finalDir, name)))) return { status: 'corrupt' };
  }
  if (!(await pathExists(io, path.join(finalDir, 'manifest.json')))) return { status: 'corrupt' };
  if (!(await verifyArtifactBytes(io, finalDir, manifest.manifest))) return { status: 'corrupt' };
  return {
    status: 'saved',
    result: {
      status: 'saved',
      artifact_ref: finalDir,
      manifest_digest: manifestDigest(manifest.manifest),
    },
  };
}

/** Attempt crash recovery: rename a complete staging package to the final dir. */
async function tryRecoverStaging(io, stagingDir, finalDir) {
  if (await pathExists(io, finalDir)) return false;
  const manifest = await readManifest(io, path.join(stagingDir, 'manifest.json'));
  if (manifest === null) return false;
  const payloadNames = ARTIFACT_FILE_NAMES.filter((name) => name !== 'manifest.json');
  for (const name of payloadNames) {
    if (!(await pathExists(io, path.join(stagingDir, name)))) return false;
  }
  if (!(await verifyArtifactBytes(io, stagingDir, manifest.manifest))) return false;
  try {
    await io.rename(stagingDir, finalDir);
    return true;
  } catch {
    return false;
  }
}

/** @param {object} io @param {string} manifestPath */
async function readManifest(io, manifestPath) {
  try {
    const text = await io.readFile(manifestPath);
    const parsed = JSON.parse(text);
    if (!isPlainObject(parsed)) return null;
    const check = validateManifest(parsed);
    if (!check.ok) return null;
    return { manifest: parsed };
  } catch {
    return null;
  }
}

/** @param {object} io @param {string} operationRecordPath */
async function readOperationRecord(io, operationRecordPath) {
  try {
    const text = await io.readFile(operationRecordPath);
    const parsed = JSON.parse(text);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** @param {object} io @param {string} operationsDir @param {string} recordPath @param {object} record */
async function writeOperationRecord(io, operationsDir, recordPath, record) {
  await io.mkdir(operationsDir, { recursive: true });
  // Temp file lives in the same directory as the record so the rename stays on
  // one volume and Windows path-length limits cannot truncate the target.
  const temporary = `${recordPath}.tmp-${process.pid}`;
  await io.writeFileDurable(temporary, newline(canonicalJson(record)));
  await io.rename(temporary, recordPath);
  await io.fsyncDir(operationsDir);
}

/** @param {unknown} left @param {unknown} right */
function sameJson(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

/** @param {string} root @param {string} relative */
function joinRelative(root, relative) {
  return `${root}/${relative}`;
}
