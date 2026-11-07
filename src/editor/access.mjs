/**
 * 06 local diagrams — document access registry (DIA-08 / DIA-RPC-01 boundary).
 *
 * The registry decides *which local documents, contexts and output roots the
 * current local user has explicitly registered*. It is deliberately separate
 * from authentication: an authenticated Host "owner" peer still needs an
 * active registry entry (and the entry's path identity must still hold) for
 * every open / save / export operation.
 *
 * Path identity contract:
 *   - paths are local absolute paths; UNC / device paths are rejected;
 *   - the real path is resolved with `realpathSync.native`;
 *   - every component of both the lexical and the resolved path is `lstat`ed
 *     and any symbolic link / Windows junction / reparse point is rejected;
 *   - the identity digest covers platform, resolved path, file type and
 *     (when available) dev/ino so a replaced directory produces a new digest;
 *   - document paths must live below an active registered output root.
 *
 * Every `lookup*` call re-resolves the path, recomputes the digest, re-checks
 * the owning context, the scope generation and the `active` flag. Nothing is
 * cached across lookups.
 */
import fs from 'node:fs';
import path from 'node:path';
import { sha256Hex } from '../canonical.mjs';
import { DiagramError, isDiagramError } from '../errors.mjs';
import { LIMITS } from '../limits.mjs';
import { validateAccessRegistry } from '../contracts.mjs';

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const DOCUMENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SHA256_RE = /^[0-9a-f]{64}$/u;
const MODES = Object.freeze(['read', 'edit']);
const KINDS = Object.freeze(['context', 'document', 'output_root']);

/** @typedef {{path:string, keyword:string, message:string}} AccessIssue */

// ---------------------------------------------------------------------------
// Small validation helpers
// ---------------------------------------------------------------------------

/** @param {unknown} value @returns {value is number} */
function isScopeGeneration(value) {
  return Number.isSafeInteger(value) && /** @type {number} */ (value) >= 0;
}

/** @param {unknown} value @returns {value is string} */
function isId(value) {
  return typeof value === 'string' && ID_RE.test(value);
}

/** @param {unknown} value @returns {value is string} */
function isDocumentId(value) {
  return typeof value === 'string' && DOCUMENT_ID_RE.test(value);
}

/** @param {unknown} value @returns {value is string} */
function isDigest(value) {
  return typeof value === 'string' && SHA256_RE.test(value);
}

/**
 * @param {AccessIssue[]} errors
 * @param {string} at
 * @param {string} keyword
 * @param {string} message
 * @returns {AccessIssue[]}
 */
function pushIssue(errors, at, keyword, message) {
  errors.push({ path: at, keyword, message });
  return errors;
}

/**
 * Normalize a thrown path error into registry issues (never throws).
 * @template T
 * @param {() => T} fn
 * @param {AccessIssue[]} errors
 * @param {string} at
 * @returns {T | undefined}
 */
function attempt(fn, errors, at) {
  try {
    return fn();
  } catch (error) {
    if (isDiagramError(error)) {
      const detail = /** @type {any} */ (error).details;
      pushIssue(errors, at, detail?.keyword ?? 'denied', error.message);
      return undefined;
    }
    pushIssue(errors, at, 'io_error', 'path could not be resolved');
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Path identity
// ---------------------------------------------------------------------------

/**
 * @param {string} candidate
 * @returns {boolean}
 */
function isUncLike(candidate) {
  if (process.platform === 'win32') return /^[\\/]{2}/u.test(candidate);
  return candidate.startsWith('//');
}

/**
 * Reject values that are not local, absolute, non-UNC filesystem paths.
 * @param {unknown} value
 * @param {string} at
 * @param {AccessIssue[]} errors
 * @returns {string | null}
 */
function checkLocalAbsolutePath(value, at, errors) {
  if (typeof value !== 'string' || value.length === 0) {
    pushIssue(errors, at, 'type', 'must be a non-empty local path string');
    return null;
  }
  if (value.includes('\u0000')) {
    pushIssue(errors, at, 'invalid_path', 'path must not contain NUL');
    return null;
  }
  if (isUncLike(value)) {
    pushIssue(errors, at, 'unc_path', 'UNC / device paths are not allowed');
    return null;
  }
  if (!path.isAbsolute(value)) {
    pushIssue(errors, at, 'not_absolute', 'path must be absolute');
    return null;
  }
  return value;
}

/**
 * Walk the lexical path from its root and reject every symlink / junction /
 * reparse component. Junctions report `isSymbolicLink() === true` on Windows,
 * so this catches both.
 * @param {string} lexicalPath
 * @returns {void}
 */
function assertNoReparseComponents(lexicalPath) {
  const resolved = path.resolve(lexicalPath);
  const root = path.parse(resolved).root;
  const rest = resolved.slice(root.length).split(path.sep).filter((part) => part.length > 0);
  let current = root;
  for (const part of rest) {
    current = path.join(current, part);
    const stats = fs.lstatSync(current);
    if (stats.isSymbolicLink()) {
      throw new DiagramError('DENIED', 'path contains a symbolic link / junction / reparse point', {
        keyword: 'reparse_point',
      });
    }
  }
}

/**
 * Resolve a trusted local path to its canonical real path.
 * @param {string} value
 * @returns {string}
 */
function resolveRealPath(value) {
  const errors = [];
  const checked = checkLocalAbsolutePath(value, '$.path', errors);
  if (checked === null) {
    throw new DiagramError('DENIED', /** @type {AccessIssue[]} */ (errors)[0].message, errors[0]);
  }
  if (process.platform === 'win32' && /^[A-Za-z]:[^\\/]/u.test(checked)) {
    throw new DiagramError('DENIED', 'drive-relative paths are not allowed', { keyword: 'not_absolute' });
  }
  assertNoReparseComponents(checked);
  const real = fs.realpathSync.native(checked);
  assertNoReparseComponents(real);
  return real;
}

/**
 * Digest of one real local path identity: platform + resolved path + file type
 * + dev/ino (when the platform reports a usable inode). Used both for registry
 * entries and `DocumentVersionV1.path_identity_digest`.
 * @param {string} realPath
 * @returns {string}
 */
export function pathIdentityDigest(realPath) {
  const real = resolveRealPath(realPath);
  const lexical = fs.lstatSync(real);
  /** @type {string} */
  let kind;
  if (lexical.isDirectory()) kind = 'dir';
  else if (lexical.isFile()) kind = 'file';
  else if (lexical.isSymbolicLink()) kind = 'link';
  else kind = 'other';
  let dev = '0';
  let ino = '0';
  try {
    const stats = fs.statSync(real, { bigint: true });
    dev = stats.dev.toString();
    ino = stats.ino.toString();
  } catch {
    // Platforms/filesystems without usable dev/ino still get the path identity.
  }
  return sha256Hex(`v1\u0000${process.platform}\u0000${real}\u0000${kind}\u0000${dev}:${ino}`);
}

/**
 * True when `candidateRealPath` is the root itself or lies below it after
 * resolving both paths. Never throws; false on any resolution error.
 * @param {string} rootRealPath
 * @param {string} candidateRealPath
 * @returns {boolean}
 */
export function isWithinRoot(rootRealPath, candidateRealPath) {
  if (typeof rootRealPath !== 'string' || typeof candidateRealPath !== 'string') return false;
  /** @type {string} */
  let root;
  /** @type {string} */
  let candidate;
  try {
    root = resolveRealPath(rootRealPath);
    candidate = resolveRealPath(candidateRealPath);
  } catch {
    return false;
  }
  const relative = path.relative(root, candidate);
  if (relative === '') return true;
  if (path.isAbsolute(relative)) return false;
  const first = relative.split(path.sep)[0];
  return first !== '..';
}

/**
 * Assert that a candidate path exists, is not a reparse target, and lies
 * below the given registered root.
 * @param {string} rootRealPath
 * @param {string} candidateRealPath
 * @returns {{ok:true, real_path:string, path_identity_digest:string} | {ok:false, errors:AccessIssue[]}}
 */
export function assertPathAllowed(rootRealPath, candidateRealPath) {
  /** @type {AccessIssue[]} */
  const errors = [];
  const root = attempt(() => resolveRealPath(rootRealPath), errors, '$.root');
  const candidate = attempt(() => resolveRealPath(candidateRealPath), errors, '$.candidate');
  if (root === undefined || candidate === undefined) return { ok: false, errors };
  const stats = attempt(() => fs.statSync(candidate), errors, '$.candidate');
  if (stats === undefined) return { ok: false, errors };
  if (!isWithinRoot(root, candidate)) {
    pushIssue(errors, '$.candidate', 'outside_root', 'path is not below the registered root');
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    real_path: candidate,
    path_identity_digest: pathIdentityDigest(candidate),
  };
}

/**
 * Check a registry document entry. Re-resolves the path binding when the entry
 * carries one (`path` / `artifact_path` / `real_path`) and compares the fresh
 * identity digest; also re-checks `active` and the field shapes.
 * @param {any} entry
 * @returns {{ok:true, real_path?:string, path_identity_digest?:string} | {ok:false, errors:AccessIssue[]}}
 */
export function verifyDocumentEntry(entry) {
  /** @type {AccessIssue[]} */
  const errors = [];
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    pushIssue(errors, '$', 'type', 'document entry must be an object');
    return { ok: false, errors };
  }
  if (!isId(entry.document_ref)) pushIssue(errors, '$.document_ref', 'id', 'must be an id (1-128 chars)');
  if (!isDocumentId(entry.document_id)) {
    pushIssue(errors, '$.document_id', 'id', 'must be a filesystem-safe document id');
  }
  if (typeof entry.scope_ref !== 'string' || entry.scope_ref.length === 0 || entry.scope_ref.length > LIMITS.scope_ref) {
    pushIssue(errors, '$.scope_ref', 'scope_ref', 'must be a non-empty scope reference');
  }
  if (!isScopeGeneration(entry.scope_generation)) {
    pushIssue(errors, '$.scope_generation', 'scope_generation', 'must be a non-negative safe integer');
  }
  if (!isDigest(entry.path_identity_digest)) {
    pushIssue(errors, '$.path_identity_digest', 'digest', 'must be a lowercase sha256 hex digest');
  }
  if (!MODES.includes(entry.mode)) pushIssue(errors, '$.mode', 'enum', 'must be read|edit');
  if (entry.active !== true) pushIssue(errors, '$.active', 'inactive', 'entry is not active');

  const bound = entry.path ?? entry.artifact_path ?? entry.real_path;
  if (bound === undefined) {
    if (errors.length === 0) {
      pushIssue(errors, '$.path', 'unbound', 'no local path binding is available for identity re-check');
    }
    return { ok: false, errors };
  }
  const real = attempt(() => resolveRealPath(/** @type {string} */ (bound)), errors, '$.path');
  if (real === undefined) return { ok: false, errors };
  let digest;
  try {
    digest = pathIdentityDigest(real);
  } catch {
    pushIssue(errors, '$.path', 'denied', 'path identity could not be computed');
    return { ok: false, errors };
  }
  if (isDigest(entry.path_identity_digest) && entry.path_identity_digest !== digest) {
    pushIssue(errors, '$.path_identity_digest', 'identity_mismatch', 'path identity changed since registration');
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, real_path: real, path_identity_digest: digest };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/** @returns {{schema_version:1, revision:number, contexts:any[], documents:any[], output_roots:any[]}} */
function emptyRegistry() {
  return { schema_version: 1, revision: 0, contexts: [], documents: [], output_roots: [] };
}

/**
 * @param {any} value
 * @param {string} at
 * @param {DiagramError} [message]
 * @returns {any}
 */
function deepClone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/**
 * Build the strict contract view of a live entry (strips the local path
 * binding, which is only kept in the persisted `local_paths` side section).
 * @param {'context'|'document'|'output_root'} kind
 * @param {any} entry
 * @returns {any}
 */
function contractEntry(kind, entry) {
  if (kind === 'context') {
    return {
      context_ref: entry.context_ref,
      scope_ref: entry.scope_ref,
      scope_generation: entry.scope_generation,
      active: entry.active,
    };
  }
  if (kind === 'document') {
    return {
      document_ref: entry.document_ref,
      document_id: entry.document_id,
      scope_ref: entry.scope_ref,
      scope_generation: entry.scope_generation,
      path_identity_digest: entry.path_identity_digest,
      mode: entry.mode,
      active: entry.active,
    };
  }
  return {
    output_ref: entry.output_ref,
    scope_ref: entry.scope_ref,
    scope_generation: entry.scope_generation,
    identity_digest: entry.identity_digest,
    active: entry.active,
  };
}

/**
 * Create the in-memory access registry.
 *
 * `initial` is the strict `DiagramAccessRegistryV1` view. A local-only
 * `local_paths` section (written by tools/registry.mjs) is accepted on load
 * and stripped from `exportToJson()`; `exportPersistedJson()` puts it back so
 * the trusted CLI can persist and later reload path bindings without ever
 * exposing raw paths through an RPC response.
 *
 * @param {any} [initial]
 * @param {{local_paths?: any}} [options]
 * @returns {{
 *   snapshot: () => any,
 *   registerContext: (entry:any) => any,
 *   registerDocument: (entry:any) => any,
 *   registerOutputRoot: (entry:any) => any,
 *   revoke: (input:{kind:string, ref:string}) => any,
 *   lookupContext: (ref:string, expectedScopeGeneration:number) => any,
 *   lookupDocument: (ref:string, expectedScopeGeneration:number) => any,
 *   lookupOutputRoot: (ref:string, expectedScopeGeneration:number) => any,
 *   exportToJson: () => any,
 *   exportPersistedJson: () => any,
 *   toJsonString: () => string,
 * }}
 */
export function createAccessRegistry(initial, options = {}) {
  /** @type {any} */
  let source = initial === undefined ? emptyRegistry() : deepClone(initial);
  if (source === null || typeof source !== 'object' || Array.isArray(source)) {
    throw new DiagramError('INVALID_ACCESS_REGISTRY', 'registry root must be an object');
  }
  /** @type {any} */
  let localPaths = source.local_paths ?? options.local_paths ?? {};
  delete source.local_paths;
  const validation = validateAccessRegistry(source);
  if (!validation || validation.ok !== true) {
    throw new DiagramError('INVALID_ACCESS_REGISTRY', 'registry does not match DiagramAccessRegistryV1', {
      errors: validation?.errors ?? [{ path: '$', keyword: 'invalid', message: 'invalid registry' }],
    });
  }

  /** @type {{schema_version:1, revision:number, contexts:any[], documents:any[], output_roots:any[]}} */
  const state = {
    schema_version: 1,
    revision: Number.isSafeInteger(source.revision) && source.revision >= 0 ? source.revision : 0,
    contexts: source.contexts.map((entry) => contractEntry('context', entry)),
    documents: source.documents.map((entry) => contractEntry('document', entry)),
    output_roots: source.output_roots.map((entry) => contractEntry('output_root', entry)),
  };
  /** @type {Map<string,string>} */
  const documentPaths = new Map(Object.entries(localPaths?.documents ?? {}).filter(([, value]) => typeof value === 'string'));
  /** @type {Map<string,string>} */
  const outputRootPaths = new Map(Object.entries(localPaths?.output_roots ?? {}).filter(([, value]) => typeof value === 'string'));

  // A missing path binding fails closed in lookups; no implicit path recovery.
  const knownDocumentRefs = new Set(state.documents.map((entry) => entry.document_ref));
  for (const ref of [...documentPaths.keys()]) {
    if (!knownDocumentRefs.has(ref)) documentPaths.delete(ref);
  }
  const knownOutputRefs = new Set(state.output_roots.map((entry) => entry.output_ref));
  for (const ref of [...outputRootPaths.keys()]) {
    if (!knownOutputRefs.has(ref)) outputRootPaths.delete(ref);
  }

  /** @param {string} kind @returns {any[]} */
  function list(kind) {
    if (kind === 'context') return state.contexts;
    if (kind === 'document') return state.documents;
    return state.output_roots;
  }

  function bumpRevision() {
    state.revision += 1;
  }

  /** @param {'context'|'document'|'output_root'} kind @param {string} ref */
  function findByRef(kind, ref) {
    const key = kind === 'context' ? 'context_ref' : kind === 'document' ? 'document_ref' : 'output_ref';
    return list(kind).find((entry) => entry[key] === ref) ?? null;
  }

  /** @param {string} scopeRef @param {number} scopeGeneration */
  function findContext(scopeRef, scopeGeneration) {
    return (
      state.contexts.find(
        (entry) => entry.scope_ref === scopeRef && entry.scope_generation === scopeGeneration,
      ) ?? null
    );
  }

  /** @param {string} scopeRef @param {number} scopeGeneration */
  function findActiveContext(scopeRef, scopeGeneration) {
    const context = findContext(scopeRef, scopeGeneration);
    return context && context.active === true ? context : null;
  }

  /**
   * @param {'document'|'output_root'} kind
   * @param {string} ref
   * @param {string} localPath
   * @param {string} scopeRef
   * @param {number} scopeGeneration
   * @param {AccessIssue[]} errors
   * @returns {string | null} real path
   */
  function checkWithinRegisteredRoot(kind, ref, localPath, scopeRef, scopeGeneration, errors) {
    const roots = state.output_roots.filter(
      (entry) =>
        entry.active === true &&
        entry.scope_ref === scopeRef &&
        entry.scope_generation === scopeGeneration,
    );
    for (const root of roots) {
      const rootPath = outputRootPaths.get(root.output_ref);
      if (rootPath === undefined) continue;
      const allowed = assertPathAllowed(rootPath, localPath);
      if (allowed.ok === true) return allowed.real_path;
    }
    pushIssue(
      errors,
      kind === 'document' ? '$.path' : '$.path',
      'outside_root',
      'path is not below any active registered output root for this scope',
    );
    return null;
  }

  /**
   * @param {any} entry
   * @param {AccessIssue[]} errors
   * @returns {any | null}
   */
  function checkContextReference(entry, errors) {
    const context = findActiveContext(entry.scope_ref, entry.scope_generation);
    if (!context) {
      pushIssue(errors, '$.scope_ref', 'context_unbound', 'no active context for scope_ref/scope_generation');
      return null;
    }
    return context;
  }

  /** @param {AccessIssue[]} errors @param {string} code @returns {any} */
  function invalid(errors, code = 'INVALID_INPUT') {
    return { ok: false, code, errors };
  }

  // -------------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------------

  function registerContext(input) {
    /** @type {AccessIssue[]} */
    const errors = [];
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      return invalid(pushIssue(errors, '$', 'type', 'context entry must be an object'));
    }
    const entry = {
      context_ref: input.context_ref,
      scope_ref: input.scope_ref,
      scope_generation: input.scope_generation,
      active: input.active === undefined ? true : input.active,
    };
    if (!isId(entry.context_ref)) pushIssue(errors, '$.context_ref', 'id', 'must be an id (1-128 chars)');
    if (typeof entry.scope_ref !== 'string' || entry.scope_ref.length === 0 || entry.scope_ref.length > LIMITS.scope_ref) {
      pushIssue(errors, '$.scope_ref', 'scope_ref', 'must be a non-empty scope reference');
    }
    if (!isScopeGeneration(entry.scope_generation)) {
      pushIssue(errors, '$.scope_generation', 'scope_generation', 'must be a non-negative safe integer');
    }
    if (typeof entry.active !== 'boolean') pushIssue(errors, '$.active', 'type', 'must be a boolean');
    if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
      const allowed = new Set(['context_ref', 'scope_ref', 'scope_generation', 'active']);
      for (const key of Object.keys(input)) {
        if (!allowed.has(key)) pushIssue(errors, `$.${key}`, 'additionalProperties', 'is not an allowed property');
      }
    }
    if (errors.length > 0) return invalid(errors);

    const existing = findByRef('context', entry.context_ref);
    if (existing) {
      const same =
        existing.scope_ref === entry.scope_ref &&
        existing.scope_generation === entry.scope_generation;
      if (!same) {
        return invalid(
          pushIssue(/** @type {AccessIssue[]} */ ([]), '$.context_ref', 'conflict', 'context_ref already registered with different scope'),
          'CONFLICT',
        );
      }
      if (existing.active !== true && entry.active === true) {
        existing.active = true;
        bumpRevision();
        return { ok: true, entry: contractEntry('context', existing), reactivated: true };
      }
      return { ok: true, entry: contractEntry('context', existing), idempotent: true };
    }
    state.contexts.push(entry);
    bumpRevision();
    return { ok: true, entry: contractEntry('context', entry) };
  }

  function registerOutputRoot(input) {
    /** @type {AccessIssue[]} */
    const errors = [];
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      return invalid(pushIssue(errors, '$', 'type', 'output root entry must be an object'));
    }
    const suppliedPath = input.path ?? input.root_path ?? input.real_path;
    const entry = {
      output_ref: input.output_ref,
      scope_ref: input.scope_ref,
      scope_generation: input.scope_generation,
      active: input.active === undefined ? true : input.active,
    };
    if (!isId(entry.output_ref)) pushIssue(errors, '$.output_ref', 'id', 'must be an id (1-128 chars)');
    if (typeof entry.scope_ref !== 'string' || entry.scope_ref.length === 0 || entry.scope_ref.length > LIMITS.scope_ref) {
      pushIssue(errors, '$.scope_ref', 'scope_ref', 'must be a non-empty scope reference');
    }
    if (!isScopeGeneration(entry.scope_generation)) {
      pushIssue(errors, '$.scope_generation', 'scope_generation', 'must be a non-negative safe integer');
    }
    if (typeof entry.active !== 'boolean') pushIssue(errors, '$.active', 'type', 'must be a boolean');
    const checkedPath = checkLocalAbsolutePath(suppliedPath, '$.path', errors);
    if (checkedPath === null) return invalid(errors);
    if (errors.length > 0) return invalid(errors);

    const realPath = attempt(() => resolveRealPath(checkedPath), errors, '$.path');
    if (realPath === undefined) return invalid(errors);
    const stats = attempt(() => fs.statSync(realPath), errors, '$.path');
    if (stats === undefined || !stats.isDirectory()) {
      if (errors.length === 0) pushIssue(errors, '$.path', 'not_directory', 'output root must be an existing directory');
      return invalid(errors);
    }
    const context = checkContextReference(entry, errors);
    if (context === null) return invalid(errors);
    const identityDigest = pathIdentityDigest(realPath);

    const existing = findByRef('output_root', entry.output_ref);
    if (existing) {
      const same =
        existing.scope_ref === entry.scope_ref &&
        existing.scope_generation === entry.scope_generation &&
        existing.identity_digest === identityDigest;
      if (!same) {
        return invalid(
          pushIssue(/** @type {AccessIssue[]} */ ([]), '$.output_ref', 'conflict', 'output_ref already registered with different path/scope'),
          'CONFLICT',
        );
      }
      outputRootPaths.set(entry.output_ref, realPath);
      if (existing.active !== true && entry.active === true) {
        existing.active = true;
        bumpRevision();
        return { ok: true, entry: contractEntry('output_root', existing), reactivated: true };
      }
      return { ok: true, entry: contractEntry('output_root', existing), idempotent: true };
    }
    state.output_roots.push({ ...entry, identity_digest: identityDigest });
    outputRootPaths.set(entry.output_ref, realPath);
    bumpRevision();
    return { ok: true, entry: contractEntry('output_root', findByRef('output_root', entry.output_ref)) };
  }

  function registerDocument(input) {
    /** @type {AccessIssue[]} */
    const errors = [];
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      return invalid(pushIssue(errors, '$', 'type', 'document entry must be an object'));
    }
    const suppliedPath = input.path ?? input.artifact_path ?? input.real_path;
    const entry = {
      document_ref: input.document_ref,
      document_id: input.document_id,
      scope_ref: input.scope_ref,
      scope_generation: input.scope_generation,
      path_identity_digest: input.path_identity_digest,
      mode: input.mode ?? 'edit',
      active: input.active === undefined ? true : input.active,
    };
    if (!isId(entry.document_ref)) pushIssue(errors, '$.document_ref', 'id', 'must be an id (1-128 chars)');
    if (!isDocumentId(entry.document_id)) {
      pushIssue(errors, '$.document_id', 'id', 'must be a filesystem-safe document id (1-128 [A-Za-z0-9._-])');
    }
    if (typeof entry.scope_ref !== 'string' || entry.scope_ref.length === 0 || entry.scope_ref.length > LIMITS.scope_ref) {
      pushIssue(errors, '$.scope_ref', 'scope_ref', 'must be a non-empty scope reference');
    }
    if (!isScopeGeneration(entry.scope_generation)) {
      pushIssue(errors, '$.scope_generation', 'scope_generation', 'must be a non-negative safe integer');
    }
    if (!MODES.includes(entry.mode)) pushIssue(errors, '$.mode', 'enum', 'must be read|edit');
    if (typeof entry.active !== 'boolean') pushIssue(errors, '$.active', 'type', 'must be a boolean');
    const checkedPath = checkLocalAbsolutePath(suppliedPath, '$.path', errors);
    if (checkedPath === null) return invalid(errors);
    if (entry.path_identity_digest !== undefined && !isDigest(entry.path_identity_digest)) {
      pushIssue(errors, '$.path_identity_digest', 'digest', 'must be a lowercase sha256 hex digest');
    }
    if (errors.length > 0) return invalid(errors);

    const realPath = attempt(() => resolveRealPath(checkedPath), errors, '$.path');
    if (realPath === undefined) return invalid(errors);
    const stats = attempt(() => fs.statSync(realPath), errors, '$.path');
    if (stats === undefined || !stats.isDirectory()) {
      if (errors.length === 0) pushIssue(errors, '$.path', 'not_directory', 'artifact path must be an existing directory');
      return invalid(errors);
    }
    const context = checkContextReference(entry, errors);
    if (context === null) return invalid(errors);
    const scopedPath = checkWithinRegisteredRoot(
      'document',
      entry.document_ref,
      realPath,
      entry.scope_ref,
      entry.scope_generation,
      errors,
    );
    if (scopedPath === null) return invalid(errors, 'DOCUMENT_DENIED');
    const identityDigest = pathIdentityDigest(scopedPath);
    if (isDigest(entry.path_identity_digest) && entry.path_identity_digest !== identityDigest) {
      return invalid(
        pushIssue(/** @type {AccessIssue[]} */ ([]), '$.path_identity_digest', 'identity_mismatch', 'supplied digest does not match current path identity'),
        'CONFLICT',
      );
    }
    entry.path_identity_digest = identityDigest;

    const samePathOwner = state.documents.find(
      (document) => document.document_id === entry.document_id && document.document_ref !== entry.document_ref,
    );
    if (samePathOwner) {
      return invalid(
        pushIssue(/** @type {AccessIssue[]} */ ([]), '$.document_id', 'conflict', 'document_id is already registered under another document_ref'),
        'CONFLICT',
      );
    }
    const duplicateIdentity = state.documents.find(
      (document) =>
        document.path_identity_digest === identityDigest && document.document_ref !== entry.document_ref,
    );
    if (duplicateIdentity) {
      return invalid(
        pushIssue(/** @type {AccessIssue[]} */ ([]), '$.path', 'conflict', 'path is already registered as another document'),
        'CONFLICT',
      );
    }

    const existing = findByRef('document', entry.document_ref);
    if (existing) {
      const same =
        existing.document_id === entry.document_id &&
        existing.scope_ref === entry.scope_ref &&
        existing.scope_generation === entry.scope_generation &&
        existing.path_identity_digest === identityDigest &&
        existing.mode === entry.mode;
      if (!same) {
        return invalid(
          pushIssue(/** @type {AccessIssue[]} */ ([]), '$.document_ref', 'conflict', 'document_ref already registered with different content'),
          'CONFLICT',
        );
      }
      documentPaths.set(entry.document_ref, scopedPath);
      if (existing.active !== true && entry.active === true) {
        existing.active = true;
        bumpRevision();
        return { ok: true, entry: contractEntry('document', existing), reactivated: true };
      }
      return { ok: true, entry: contractEntry('document', existing), idempotent: true };
    }
    state.documents.push(entry);
    documentPaths.set(entry.document_ref, scopedPath);
    bumpRevision();
    return { ok: true, entry: contractEntry('document', findByRef('document', entry.document_ref)) };
  }

  // -------------------------------------------------------------------------
  // Revocation
  // -------------------------------------------------------------------------

  function revoke(input) {
    /** @type {AccessIssue[]} */
    const errors = [];
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      return invalid(pushIssue(errors, '$', 'type', 'revoke input must be an object'));
    }
    const kind = input.kind;
    if (!KINDS.includes(kind)) {
      return invalid(pushIssue(errors, '$.kind', 'enum', 'kind must be context|document|output_root'));
    }
    if (!isId(input.ref)) return invalid(pushIssue(errors, '$.ref', 'id', 'ref must be an id (1-128 chars)'));
    // Optional scope_generation (independent review R-04): revoking one scope
    // generation must never cascade into a newer generation of the same scope.
    const generation = input.scope_generation;
    if (generation !== undefined && !isScopeGeneration(generation)) {
      return invalid(pushIssue(errors, '$.scope_generation', 'type', 'scope_generation must be a non-negative safe integer'));
    }
    const key = kind === 'context' ? 'context_ref' : kind === 'document' ? 'document_ref' : 'output_ref';
    const entries = list(kind).filter(
      (entry) => entry[key] === input.ref && (generation === undefined || entry.scope_generation === generation),
    );
    if (entries.length === 0) return { ok: false, code: 'NOT_FOUND', errors: [] };
    /** @type {{contexts:number, documents:number, output_roots:number}} */
    const affected = { contexts: 0, documents: 0, output_roots: 0 };
    const activeEntries = entries.filter((entry) => entry.active === true);
    if (activeEntries.length === 0) {
      return { ok: true, revoked: false, already_revoked: true, affected };
    }
    for (const entry of activeEntries) {
      entry.active = false;
      affected[kind === 'context' ? 'contexts' : kind === 'document' ? 'documents' : 'output_roots'] += 1;
      if (kind === 'context') {
        for (const document of state.documents) {
          if (document.active !== true) continue;
          if (document.scope_ref !== entry.scope_ref || document.scope_generation !== entry.scope_generation) continue;
          document.active = false;
          affected.documents += 1;
        }
        for (const root of state.output_roots) {
          if (root.active !== true) continue;
          if (root.scope_ref !== entry.scope_ref || root.scope_generation !== entry.scope_generation) continue;
          root.active = false;
          affected.output_roots += 1;
        }
      } else if (kind === 'output_root') {
        const rootPath = outputRootPaths.get(entry.output_ref);
        for (const document of state.documents) {
          if (document.active !== true) continue;
          if (document.scope_ref !== entry.scope_ref || document.scope_generation !== entry.scope_generation) continue;
          const documentPath = documentPaths.get(document.document_ref);
          if (documentPath === undefined || rootPath === undefined) continue;
          if (isWithinRoot(rootPath, documentPath)) {
            document.active = false;
            affected.documents += 1;
          }
        }
      }
    }
    bumpRevision();
    return { ok: true, revoked: true, affected };
  }

  // -------------------------------------------------------------------------
  // Lookups (re-check everything each time)
  // -------------------------------------------------------------------------

  /** @param {unknown} expectedScopeGeneration @returns {boolean} */
  function validExpectedGeneration(expectedScopeGeneration) {
    return isScopeGeneration(expectedScopeGeneration);
  }

  function contextLookup(ref, expectedScopeGeneration) {
    if (!isId(ref)) return { ok: false, code: 'CONTEXT_UNBOUND', errors: [] };
    if (!validExpectedGeneration(expectedScopeGeneration)) {
      return { ok: false, code: 'SCOPE_REVOKED', errors: [] };
    }
    const entry = findByRef('context', ref);
    if (entry === null || entry.active !== true) return { ok: false, code: 'CONTEXT_UNBOUND', errors: [] };
    if (entry.scope_generation !== expectedScopeGeneration) return { ok: false, code: 'SCOPE_REVOKED', errors: [] };
    return { ok: true, entry: contractEntry('context', entry) };
  }

  function lookupDocument(ref, expectedScopeGeneration) {
    if (!isId(ref)) return { ok: false, code: 'DOCUMENT_DENIED', errors: [] };
    if (!validExpectedGeneration(expectedScopeGeneration)) {
      return { ok: false, code: 'SCOPE_REVOKED', errors: [] };
    }
    const entry = findByRef('document', ref);
    if (entry === null || entry.active !== true) return { ok: false, code: 'DOCUMENT_DENIED', errors: [] };
    if (entry.scope_generation !== expectedScopeGeneration) return { ok: false, code: 'SCOPE_REVOKED', errors: [] };
    const context = findContext(entry.scope_ref, entry.scope_generation);
    if (context === null || context.active !== true) return { ok: false, code: 'SCOPE_REVOKED', errors: [] };
    const boundPath = documentPaths.get(ref);
    if (boundPath === undefined) return { ok: false, code: 'DOCUMENT_DENIED', errors: [] };
    const verified = verifyDocumentEntry({ ...contractEntry('document', entry), path: boundPath });
    if (verified.ok !== true) return { ok: false, code: 'DOCUMENT_DENIED', errors: verified.errors };
    if (!isWithinActiveOutputRoot(verified.real_path, entry.scope_ref, entry.scope_generation)) {
      return { ok: false, code: 'DOCUMENT_DENIED', errors: [] };
    }
    return { ok: true, entry: contractEntry('document', entry), real_path: verified.real_path };
  }

  function lookupOutputRoot(ref, expectedScopeGeneration) {
    if (!isId(ref)) return { ok: false, code: 'CONTEXT_UNBOUND', errors: [] };
    if (!validExpectedGeneration(expectedScopeGeneration)) {
      return { ok: false, code: 'SCOPE_REVOKED', errors: [] };
    }
    const entry = findByRef('output_root', ref);
    if (entry === null || entry.active !== true) return { ok: false, code: 'CONTEXT_UNBOUND', errors: [] };
    if (entry.scope_generation !== expectedScopeGeneration) return { ok: false, code: 'SCOPE_REVOKED', errors: [] };
    const context = findContext(entry.scope_ref, entry.scope_generation);
    if (context === null || context.active !== true) return { ok: false, code: 'SCOPE_REVOKED', errors: [] };
    const boundPath = outputRootPaths.get(ref);
    if (boundPath === undefined) return { ok: false, code: 'CONTEXT_UNBOUND', errors: [] };
    const real = attempt(() => resolveRealPath(boundPath), [], '$');
    if (real === undefined) return { ok: false, code: 'CONTEXT_UNBOUND', errors: [] };
    let digest;
    try {
      digest = pathIdentityDigest(real);
    } catch {
      return { ok: false, code: 'CONTEXT_UNBOUND', errors: [] };
    }
    if (digest !== entry.identity_digest) return { ok: false, code: 'CONTEXT_UNBOUND', errors: [] };
    return { ok: true, entry: contractEntry('output_root', entry), real_path: real };
  }

  /**
   * @param {string} realPath
   * @param {string} scopeRef
   * @param {number} scopeGeneration
   * @returns {boolean}
   */
  function isWithinActiveOutputRoot(realPath, scopeRef, scopeGeneration) {
    for (const root of state.output_roots) {
      if (root.active !== true || root.scope_ref !== scopeRef || root.scope_generation !== scopeGeneration) continue;
      const rootPath = outputRootPaths.get(root.output_ref);
      if (rootPath === undefined) continue;
      if (isWithinRoot(rootPath, realPath)) return true;
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // Views
  // -------------------------------------------------------------------------

  function snapshot() {
    return deepClone(state);
  }

  function localPathView() {
    return {
      documents: Object.fromEntries(documentPaths.entries()),
      output_roots: Object.fromEntries(outputRootPaths.entries()),
    };
  }

  function exportToJson() {
    return deepClone(state);
  }

  function exportPersistedJson() {
    const contract = deepClone(state);
    return { ...contract, local_paths: localPathView() };
  }

  return {
    snapshot,
    registerContext,
    registerDocument,
    registerOutputRoot,
    revoke,
    lookupContext: contextLookup,
    lookupDocument,
    lookupOutputRoot,
    exportToJson,
    exportPersistedJson,
    toJsonString: () => JSON.stringify(exportPersistedJson()),
    /** Local-trusted helper: list refs + bound path presence (never exposes paths). */
    listLocalBindings: () => ({
      documents: [...documentPaths.keys()],
      output_roots: [...outputRootPaths.keys()],
    }),
  };
}

// ---------------------------------------------------------------------------
// Local registry persistence (trusted local CLI seam; not an RPC surface)
// ---------------------------------------------------------------------------

/**
 * Resolve the local registry data root.
 * Priority: explicit argument → `DSH_HOME/local-diagrams`.
 * @param {string | undefined} explicitDataRoot
 * @returns {string} real registry directory
 */
export function resolveRegistryDataRoot(explicitDataRoot) {
  /** @type {string} */
  let candidate;
  if (typeof explicitDataRoot === 'string' && explicitDataRoot.length > 0) {
    candidate = explicitDataRoot;
  } else {
    const home = process.env.DSH_HOME;
    if (typeof home !== 'string' || home.length === 0) {
      throw new DiagramError(
        'INVALID_INPUT',
        'registry data root is required: pass --data-root or set DSH_HOME',
      );
    }
    candidate = path.join(home, 'local-diagrams');
  }
  const errors = [];
  const checked = checkLocalAbsolutePath(candidate, '$.data_root', errors);
  if (checked === null) {
    throw new DiagramError('INVALID_INPUT', /** @type {AccessIssue[]} */ (errors)[0].message, errors[0]);
  }
  fs.mkdirSync(checked, { recursive: true });
  return fs.realpathSync.native(checked);
}

/**
 * File names used by the local registry. `registry.json` is the strict
 * contract view (safe to validate with contracts.validateAccessRegistry);
 * `registry.local.json` holds the trusted local path bindings.
 * @param {string} dataRoot
 * @returns {{registry:string, local:string, directory:string}}
 */
export function registryFilePaths(dataRoot) {
  const directory = resolveRegistryDataRoot(dataRoot);
  return {
    directory,
    registry: path.join(directory, 'registry.json'),
    local: path.join(directory, 'registry.local.json'),
  };
}

/**
 * @param {string} file
 * @param {unknown} value
 * @returns {void}
 */
function writeJsonAtomic(file, value) {
  const temp = `${file}.tmp-${process.pid}-${Date.now().toString(16)}`;
  const handle = fs.openSync(temp, 'wx', 0o600);
  try {
    fs.writeFileSync(handle, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  fs.renameSync(temp, file);
}

/**
 * Persist the registry under the trusted local data root.
 * @param {string} dataRoot
 * @param {any} registry
 * @returns {{ok:true, registry_path:string, local_path:string}}
 */
export function saveRegistryToDirectory(dataRoot, registry) {
  if (!registry || typeof registry.exportToJson !== 'function' || typeof registry.exportPersistedJson !== 'function') {
    throw new DiagramError('INVALID_INPUT', 'registry instance is required');
  }
  const files = registryFilePaths(dataRoot);
  const contract = registry.exportToJson();
  const contractValidation = validateAccessRegistry(contract);
  if (!contractValidation || contractValidation.ok !== true) {
    throw new DiagramError('INVALID_ACCESS_REGISTRY', 'refusing to persist an invalid registry', {
      errors: contractValidation?.errors,
    });
  }
  const persisted = registry.exportPersistedJson();
  writeJsonAtomic(files.registry, contract);
  writeJsonAtomic(files.local, {
    schema_version: 1,
    revision: persisted.revision,
    local_paths: persisted.local_paths,
  });
  return { ok: true, registry_path: files.registry, local_path: files.local };
}

/**
 * Load the registry from the trusted local data root. Missing files yield an
 * empty registry (first use); invalid JSON or invalid contract throws a coded
 * DiagramError. Path bindings are attached when `registry.local.json` exists.
 * @param {string} dataRoot
 * @returns {{ok:true, registry:any, had_local_bindings:boolean}}
 */
export function loadRegistryFromDirectory(dataRoot) {
  const files = registryFilePaths(dataRoot);
  /** @type {any} */
  let contract;
  if (!fs.existsSync(files.registry)) {
    contract = emptyRegistry();
  } else {
    try {
      contract = JSON.parse(fs.readFileSync(files.registry, 'utf8'));
    } catch {
      throw new DiagramError('INVALID_ACCESS_REGISTRY', 'registry.json is not valid JSON');
    }
  }
  /** @type {any} */
  let localPaths = undefined;
  let hadLocalBindings = false;
  if (fs.existsSync(files.local)) {
    try {
      const local = JSON.parse(fs.readFileSync(files.local, 'utf8'));
      if (local && typeof local === 'object' && local.local_paths && typeof local.local_paths === 'object') {
        localPaths = local.local_paths;
        hadLocalBindings = true;
      }
    } catch {
      throw new DiagramError('INVALID_ACCESS_REGISTRY', 'registry.local.json is not valid JSON');
    }
  }
  const registry = createAccessRegistry(contract, { local_paths: localPaths });
  return { ok: true, registry, had_local_bindings: hadLocalBindings };
}

