/**
 * 06 local diagrams —immutable document store (DIA-08 / DIA-09).
 *
 * Physical v1 model (software-design §8):
 *
 *   <data_root>/documents/<document_id>/
 *     pointer.json                         current revision pointer (atomic)
 *     journal.jsonl                        prepared → revision_written → pointer_updated → saved
 *     revisions/<generation>-<sha>.drawio  immutable canonical XML
 *     revisions/<generation>-<sha>.base.json
 *     revisions/<generation>-<sha>.overlay.json
 *     revisions/<generation>-<sha>.manifest.json
 *     drafts/<session_key>/<sha256>.xml    last N drafts per editor session
 *
 * Save is "save as new immutable revision": the only mutable metadata is the
 * small pointer file, replaced atomically and journaled. A save never
 * overwrites an existing revision, never retries with a newer token, and
 * refuses to continue when the expected version or a path identity no longer
 * matches. Crash recovery consults the journal, finishes exactly the
 * operations that are provably committed, and leaves the old pointer intact
 * otherwise.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { canonicalJson, digestOf, sha256Hex } from '../canonical.mjs';
import { DiagramError, isDiagramError } from '../errors.mjs';
import { LIMITS } from '../limits.mjs';
import {
  validateDiagramSpec,
  validateOverlay,
  validateManifest,
  validateDocumentVersion,
  validateComposite,
  specDigest,
  manifestDigest,
} from '../contracts.mjs';
import { parseDrawioXml, canonicalMxGraph, exportDrawio } from '../drawio/xml.mjs';
import { pathIdentityDigest, isWithinRoot } from './access.mjs';

const DOCUMENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const OPERATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SESSION_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SHA256_RE = /^[0-9a-f]{64}$/u;
const DRAFT_FILE_RE = /^[0-9a-f]{64}\.xml$/u;
const FORMATS = Object.freeze(['drawio', 'json', 'svg']);
const LOCK_TTL_MS = 5 * 60 * 1000;
const FS_FSYNC_DIR_ERRORS = new Set(['EINVAL', 'EPERM', 'EACCES', 'EISDIR', 'EBADF', 'ENOTSUP', 'ENOSYS']);

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** @param {unknown} value @returns {value is string} */
function isDocumentId(value) {
  return typeof value === 'string' && DOCUMENT_ID_RE.test(value);
}

/** @param {unknown} value @returns {value is string} */
function isOperationId(value) {
  return typeof value === 'string' && OPERATION_ID_RE.test(value);
}

/** @param {unknown} value @returns {value is string} */
function isSha256(value) {
  return typeof value === 'string' && SHA256_RE.test(value);
}

/** @param {unknown} value @returns {value is number} */
function isGeneration(value) {
  return Number.isSafeInteger(value) && /** @type {number} */ (value) >= 0;
}

/** @param {unknown} value @returns {boolean} */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** @param {Error & {code?: string}} error @returns {boolean} */
function isFsCode(error, codes) {
  return typeof error?.code === 'string' && codes.includes(error.code);
}

/**
 * Best-effort directory fsync; Windows often refuses to open a directory handle
 * (`EISDIR`/`EPERM`). The limitation is documented and does not hide injected
 * crash errors (those have no known fs code and are re-thrown).
 * @param {any} fsm
 * @param {string} dir
 * @returns {void}
 */
function fsyncDirectory(fsm, dir) {
  /** @type {number | undefined} */
  let handle;
  try {
    handle = fsm.openSync(dir, 'r');
    fsm.fsyncSync(handle);
  } catch (error) {
    if (!isFsCode(/** @type {any} */ (error), [...FS_FSYNC_DIR_ERRORS])) throw error;
  } finally {
    if (handle !== undefined) {
      try {
        fsm.closeSync(handle);
      } catch {
        // ignore close failure on a best-effort directory fsync
      }
    }
  }
}

/**
 * Write a small file durably (temp file in the same directory + fsync).
 * @param {any} fsm
 * @param {string} file final path
 * @param {string | Buffer} data
 * @param {string} tmpSuffix
 * @returns {string} temp path
 */
function stageFile(fsm, file, data, tmpSuffix) {
  const temp = `${file}.tmp-${tmpSuffix}`;
  const handle = fsm.openSync(temp, 'wx', 0o600);
  try {
    fsm.writeFileSync(handle, data);
    fsm.fsyncSync(handle);
  } finally {
    fsm.closeSync(handle);
  }
  return temp;
}

/**
 * Small synchronous sleep used only for cross-process advisory lock backoff.
 * @param {number} ms
 * @returns {void}
 */
function sleepSync(ms) {
  const buffer = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buffer, 0, 0, ms);
}

/** @param {string} text @returns {string} */
function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** @param {string} value @returns {string} */
function leafFileName(value) {
  return value.slice(value.lastIndexOf(path.sep) + 1);
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/**
 * Create the document store.
 *
 * Extra options beyond the interface text:
 *   - `fs`: node:fs-compatible synchronous module used for every filesystem
 *     access. Tests inject a wrapper to simulate crash points (`ENOSPC`,
 *     interruption after a specific syscall). Never a production seam.
 *
 * All methods are async (they may perform filesystem work); callers should
 * `await` them. Results follow interfaces.md §9 and never throw for expected
 * business conditions.
 *
 * @param {{data_root:string, registry:any, clock?:() => any, limits?:object, fs?:any}} options
 * @returns {any}
 */
export function createDocumentStore(options) {
  if (!isPlainObject(options)) {
    throw new DiagramError('INVALID_INPUT', 'createDocumentStore requires an options object');
  }
  const { data_root: dataRootOption, registry } = /** @type {any} */ (options);
  const clock = /** @type {any} */ (options).clock ?? (() => new Date().toISOString());
  const limits = { ...LIMITS, ...(/** @type {any} */ (options).limits ?? {}) };
  const fsm = /** @type {any} */ (options).fs ?? fs;
  if (typeof clock !== 'function') throw new DiagramError('INVALID_INPUT', 'clock must be a function');
  if (!registry || typeof registry.lookupDocument !== 'function' || typeof registry.lookupOutputRoot !== 'function') {
    throw new DiagramError('INVALID_INPUT', 'registry must be a created access registry');
  }
  if (typeof dataRootOption !== 'string' || dataRootOption.length === 0 || dataRootOption.includes('\u0000')) {
    throw new DiagramError('INVALID_INPUT', 'data_root must be a local absolute path');
  }
  if (process.platform === 'win32' ? /^[\\/]{2}/u.test(dataRootOption) : dataRootOption.startsWith('//')) {
    throw new DiagramError('INVALID_INPUT', 'data_root must not be a UNC / device path');
  }
  if (!path.isAbsolute(dataRootOption)) throw new DiagramError('INVALID_INPUT', 'data_root must be absolute');

  fs.mkdirSync(dataRootOption, { recursive: true });
  const dataRoot = fs.realpathSync.native(dataRootOption);
  // Fails on symlink/junction/reparse components.
  const dataRootIdentity = pathIdentityDigest(dataRoot);

  /** @type {Map<string, any>} */
  const sessions = new Map();
  /** @type {Map<string, Promise<void>>} */
  const documentChains = new Map();
  let disposed = false;

  // -------------------------------------------------------------------------
  // Clock / caller helpers
  // -------------------------------------------------------------------------

  function clockMs() {
    const value = clock();
    if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
    if (value instanceof Date && Number.isFinite(value.getTime())) return value.getTime();
    if (typeof value === 'string') {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    throw new DiagramError('INTERNAL_FAILURE', 'clock must return an ISO timestamp, Date or epoch ms');
  }

  function nowIso() {
    return new Date(clockMs()).toISOString();
  }

  /**
   * @param {any} caller
   * @returns {{kind:'owner', principal_id:string} | null}
   */
  function ownerCaller(caller) {
    if (!isPlainObject(caller)) return null;
    const principal = isPlainObject(caller.principal) ? caller.principal : undefined;
    const kind = principal?.kind ?? caller.kind;
    if (kind !== 'owner') return null;
    const id = principal?.principal_id ?? principal?.id ?? caller.principal_id;
    return { kind: 'owner', principal_id: typeof id === 'string' && id.length > 0 ? id : 'owner' };
  }

  /**
   * Scope generation supplied by the trusted caller envelope, when present.
   * @param {any} caller
   * @returns {number | undefined}
   */
  function callerScopeGeneration(caller) {
    const candidate = caller?.context?.scope_generation ?? caller?.scope_generation;
    return isGeneration(candidate) ? candidate : undefined;
  }

  /**
   * Find the active registry document entry for a document_id.
   * @param {string} documentId
   * @param {any} caller
   * @param {'read'|'edit'|'any'} requireMode
   * @returns {{ok:true, entry:any, ref:string, real_path:string, scope_generation:number} | {ok:false, status:string, code:string}}
   */
  function resolveDocumentAccess(documentId, caller, requireMode) {
    if (!isDocumentId(documentId)) return { ok: false, status: 'denied', code: 'DOCUMENT_DENIED' };
    const contract = registry.exportToJson();
    const matches = contract.documents.filter((entry) => entry.document_id === documentId && entry.active === true);
    if (matches.length !== 1) return { ok: false, status: 'denied', code: 'DOCUMENT_DENIED' };
    const entry = matches[0];
    if (requireMode !== 'any' && entry.mode !== requireMode) {
      return { ok: false, status: 'denied', code: 'DOCUMENT_DENIED' };
    }
    const expectedGeneration = callerScopeGeneration(caller) ?? entry.scope_generation;
    const lookup = registry.lookupDocument(entry.document_ref, expectedGeneration);
    if (lookup.ok !== true) {
      return {
        ok: false,
        status: 'denied',
        code: lookup.code === 'DOCUMENT_DENIED' ? 'DOCUMENT_DENIED' : 'SCOPE_REVOKED',
      };
    }
    return {
      ok: true,
      entry: lookup.entry,
      ref: entry.document_ref,
      real_path: lookup.real_path,
      scope_generation: lookup.entry.scope_generation,
    };
  }

  // -------------------------------------------------------------------------
  // Path helpers
  // -------------------------------------------------------------------------

  /** @param {string} documentId @returns {string} */
  function documentDirectory(documentId) {
    if (!isDocumentId(documentId)) throw new DiagramError('INVALID_INPUT', 'invalid document_id');
    return path.join(dataRoot, 'documents', documentId);
  }

  /**
   * @param {string} documentId
   * @returns {string} real document directory
   */
  function ensureDocumentDirectory(documentId) {
    const dir = documentDirectory(documentId);
    fsm.mkdirSync(path.join(dataRoot, 'documents'), { recursive: true });
    fsm.mkdirSync(dir, { recursive: true });
    const real = fs.realpathSync.native(dir);
    if (!isWithinRoot(dataRoot, real)) {
      throw new DiagramError('DENIED', 'document directory escapes the data root', { keyword: 'outside_root' });
    }
    // Rejects a junction planted as documents/<id>.
    const identity = pathIdentityDigest(real);
    return { real, identity };
  }

  /** @param {string} documentId @returns {string} */
  function pointerPath(documentId) {
    return path.join(documentDirectory(documentId), 'pointer.json');
  }

  /** @param {string} documentId @returns {string} */
  function journalPath(documentId) {
    return path.join(documentDirectory(documentId), 'journal.jsonl');
  }

  /** @param {string} documentId @returns {string} */
  function revisionsDirectory(documentId) {
    return path.join(documentDirectory(documentId), 'revisions');
  }

  /**
   * @param {string} documentId
   * @param {number} generation
   * @param {string} contentSha256
   * @returns {{xml:string, base:string, overlay:string, manifest:string}}
   */
  function revisionPaths(documentId, generation, contentSha256) {
    const base = path.join(revisionsDirectory(documentId), `${generation}-${contentSha256}`);
    return {
      xml: `${base}.drawio`,
      base: `${base}.base.json`,
      overlay: `${base}.overlay.json`,
      manifest: `${base}.manifest.json`,
    };
  }

  // -------------------------------------------------------------------------
  // Durable read / journal helpers
  // -------------------------------------------------------------------------

  /**
   * Read one file while proving it did not change between stat and read.
   * Retries exactly once, then reports CONFLICT.
   * @param {string} file
   * @param {{expectedSha256?:string, expectedSize?:number, maxBytes?:number}} [options]
   * @returns {{ok:true, bytes:Buffer, sha256:string, size:number} | {ok:false, code:string}}
   */
  function readStableFile(file, options = {}) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      /** @type {any} */
      let before;
      try {
        before = fsm.lstatSync(file);
      } catch (error) {
        if (isFsCode(/** @type {any} */ (error), ['ENOENT', 'ENOTDIR'])) return { ok: false, code: 'NOT_FOUND' };
        return { ok: false, code: 'OUTCOME_UNKNOWN' };
      }
      if (before.isSymbolicLink() || !before.isFile()) return { ok: false, code: 'DENIED' };
      if (typeof options.maxBytes === 'number' && before.size > options.maxBytes) {
        return { ok: false, code: 'LIMIT_EXCEEDED' };
      }
      let bytes;
      try {
        bytes = fsm.readFileSync(file);
      } catch {
        return { ok: false, code: 'OUTCOME_UNKNOWN' };
      }
      /** @type {any} */
      let after;
      try {
        after = fsm.lstatSync(file);
      } catch {
        return { ok: false, code: 'OUTCOME_UNKNOWN' };
      }
      if (before.size !== after.size) continue;
      if (typeof options.expectedSize === 'number' && bytes.length !== options.expectedSize) continue;
      const sha256 = sha256Hex(bytes);
      if (typeof options.expectedSha256 === 'string' && sha256 !== options.expectedSha256) continue;
      return { ok: true, bytes, sha256, size: bytes.length };
    }
    return { ok: false, code: 'CONFLICT' };
  }

  /**
   * @param {string} documentId
   * @returns {{entries:any[], malformed:number}}
   */
  function readJournal(documentId) {
    const file = journalPath(documentId);
    let raw;
    try {
      raw = fsm.readFileSync(file);
    } catch (error) {
      if (isFsCode(/** @type {any} */ (error), ['ENOENT', 'ENOTDIR'])) return { entries: [], malformed: 0 };
      throw error;
    }
    /** @type {any[]} */
    const entries = [];
    let malformed = 0;
    const text = raw.toString('utf8');
    for (const line of text.split('\n')) {
      if (line.trim().length === 0) continue;
      try {
        const parsed = JSON.parse(line);
        if (isPlainObject(parsed) && isOperationId(parsed.operation_id) && typeof parsed.type === 'string') {
          entries.push(parsed);
        } else {
          malformed += 1;
        }
      } catch {
        malformed += 1;
      }
    }
    if (entries.length > limits.journal_entries_scan) {
      entries.splice(0, entries.length - limits.journal_entries_scan);
    }
    return { entries, malformed };
  }

  /**
   * @param {string} documentId
   * @returns {number}
   */
  function lastJournalSeq(documentId) {
    const { entries } = readJournal(documentId);
    let seq = 0;
    for (const entry of entries) {
      if (Number.isSafeInteger(entry.seq) && entry.seq > seq) seq = entry.seq;
    }
    return seq;
  }

  /**
   * @param {string} documentId
   * @param {any} entry
   * @param {number} seq
   * @returns {any} the appended entry
   */
  function appendJournal(documentId, entry, seq) {
    const record = {
      schema_version: 1,
      seq,
      at: nowIso(),
      document_id: documentId,
      ...entry,
    };
    const file = journalPath(documentId);
    const handle = fsm.openSync(file, 'a', 0o600);
    try {
      fsm.writeFileSync(handle, `${JSON.stringify(record)}\n`);
      fsm.fsyncSync(handle);
    } finally {
      fsm.closeSync(handle);
    }
    fsyncDirectory(fsm, path.dirname(file));
    return record;
  }

  /**
   * Record that an operation will never be published (keeps crash recovery
   * from finalizing a pointer the caller was told did not happen).
   * @param {string} documentId
   * @param {string} operationId
   * @param {string | null} documentRef
   * @param {string} reasonCode
   * @returns {void}
   */
  function journalOperationFailure(documentId, operationId, documentRef, reasonCode) {
    appendJournal(
      documentId,
      {
        type: 'failed',
        operation_id: operationId,
        document_ref: documentRef ?? null,
        reason_code: reasonCode,
      },
      lastJournalSeq(documentId) + 1,
    );
  }

  // -------------------------------------------------------------------------
  // Pointer / revision state
  // -------------------------------------------------------------------------

  /**
   * @param {any} pointer
   * @returns {string[]} problems
   */
  function pointerProblems(pointer) {
    /** @type {string[]} */
    const problems = [];
    if (!isPlainObject(pointer)) return ['pointer must be an object'];
    if (pointer.schema_version !== 1) problems.push('schema_version');
    if (!isDocumentId(pointer.document_id)) problems.push('document_id');
    if (!isGeneration(pointer.generation)) problems.push('generation');
    if (!isSha256(pointer.content_sha256)) problems.push('content_sha256');
    if (!Number.isSafeInteger(pointer.byte_length) || pointer.byte_length < 0) problems.push('byte_length');
    if (!isSha256(pointer.path_identity_digest)) problems.push('path_identity_digest');
    if (typeof pointer.operation_id !== 'string' || pointer.operation_id.length === 0) problems.push('operation_id');
    return problems;
  }

  /**
   * @param {string} documentId
   * @returns {{ok:true, pointer:any} | {ok:false, code:string}}
   */
  function readPointer(documentId) {
    const read = readStableFile(pointerPath(documentId), { maxBytes: 64 * 1024 });
    if (read.ok !== true) return { ok: false, code: read.code };
    let pointer;
    try {
      pointer = JSON.parse(stripBom(read.bytes.toString('utf8')));
    } catch {
      return { ok: false, code: 'OUTCOME_UNKNOWN' };
    }
    const problems = pointerProblems(pointer);
    if (problems.length > 0) return { ok: false, code: 'OUTCOME_UNKNOWN' };
    if (pointer.document_id !== documentId) return { ok: false, code: 'OUTCOME_UNKNOWN' };
    return { ok: true, pointer };
  }

  /**
   * @param {string} documentId
   * @param {string} operationId
   * @param {any} version
   * @param {number} generation
   * @param {string} contentSha256
   * @returns {any} pointer object
   */
  function buildPointer(documentId, operationId, version, generation, contentSha256) {
    return {
      schema_version: 1,
      document_id: documentId,
      generation,
      content_sha256: contentSha256,
      byte_length: version.byte_length,
      path_identity_digest: version.path_identity_digest,
      operation_id: operationId,
      updated_at: nowIso(),
    };
  }

  /**
   * Atomically replace pointer.json (temp + fsync + rename + dir fsync).
   * @param {string} documentId
   * @param {any} pointer
   * @returns {void}
   */
  function writePointer(documentId, pointer) {
    const final = pointerPath(documentId);
    const temp = stageFile(fsm, final, `${canonicalJson(pointer)}\n`, randomBytes(8).toString('hex'));
    fsm.renameSync(temp, final);
    fsyncDirectory(fsm, path.dirname(final));
  }

  /**
   * Validate the immutable revision triple referenced by a pointer and return
   * its parsed content plus the freshly computed version.
   * @param {string} documentId
   * @param {any} pointer
   * @param {string} docIdentity
   * @returns {{ok:true, xml:string, base_spec:any, overlay:any, version:any} | {ok:false, code:string}}
   */
  function loadRevision(documentId, pointer, docIdentity) {
    const paths = revisionPaths(documentId, pointer.generation, pointer.content_sha256);
    const xmlRead = readStableFile(paths.xml, {
      expectedSha256: pointer.content_sha256,
      expectedSize: pointer.byte_length,
      maxBytes: limits.document_xml_bytes,
    });
    if (xmlRead.ok !== true) {
      if (xmlRead.code === 'LIMIT_EXCEEDED') return { ok: false, code: 'LIMIT_EXCEEDED' };
      return { ok: false, code: 'OUTCOME_UNKNOWN' };
    }
    const xml = xmlRead.bytes.toString('utf8');
    if (!Buffer.from(xml, 'utf8').equals(xmlRead.bytes)) return { ok: false, code: 'OUTCOME_UNKNOWN' };
    const parsedXml = parseDrawioXml(xml, { limits });
    if (parsedXml.ok !== true) return { ok: false, code: 'OUTCOME_UNKNOWN' };

    const manifestRead = readStableFile(paths.manifest, { maxBytes: 256 * 1024 });
    if (manifestRead.ok !== true) return { ok: false, code: 'OUTCOME_UNKNOWN' };
    let revisionManifest;
    try {
      revisionManifest = JSON.parse(stripBom(manifestRead.bytes.toString('utf8')));
    } catch {
      return { ok: false, code: 'OUTCOME_UNKNOWN' };
    }
    if (
      !isPlainObject(revisionManifest) ||
      revisionManifest.document_id !== documentId ||
      revisionManifest.generation !== pointer.generation ||
      revisionManifest.content_sha256 !== pointer.content_sha256 ||
      revisionManifest.byte_length !== pointer.byte_length
    ) {
      return { ok: false, code: 'OUTCOME_UNKNOWN' };
    }
    const baseRead = readStableFile(paths.base, {
      expectedSha256: revisionManifest.base_sha256,
      maxBytes: limits.package_bytes,
    });
    if (baseRead.ok !== true) return { ok: false, code: 'OUTCOME_UNKNOWN' };
    const overlayRead = readStableFile(paths.overlay, {
      expectedSha256: revisionManifest.overlay_sha256,
      maxBytes: limits.package_bytes,
    });
    if (overlayRead.ok !== true) return { ok: false, code: 'OUTCOME_UNKNOWN' };
    let baseSpec;
    let overlay;
    try {
      baseSpec = JSON.parse(stripBom(baseRead.bytes.toString('utf8')));
      overlay = JSON.parse(stripBom(overlayRead.bytes.toString('utf8')));
    } catch {
      return { ok: false, code: 'OUTCOME_UNKNOWN' };
    }
    const specValidation = validateDiagramSpec(baseSpec);
    if (specValidation.ok !== true) return { ok: false, code: 'OUTCOME_UNKNOWN' };
    const overlayValidation = validateOverlay(overlay);
    if (overlayValidation.ok !== true) return { ok: false, code: 'OUTCOME_UNKNOWN' };
    const compositeValidation = validateComposite(baseSpec, overlay);
    if (compositeValidation.ok !== true) return { ok: false, code: 'OUTCOME_UNKNOWN' };
    if (specDigest(baseSpec) !== revisionManifest.base_spec_digest) return { ok: false, code: 'OUTCOME_UNKNOWN' };
    const version = {
      schema_version: 1,
      document_id: documentId,
      generation: pointer.generation,
      content_sha256: pointer.content_sha256,
      byte_length: pointer.byte_length,
      path_identity_digest: docIdentity,
    };
    return { ok: true, xml, base_spec: baseSpec, overlay, version };
  }

  /**
   * Load the current immutable revision.
   * @param {string} documentId
   * @returns {{ok:true, pointer:any, doc_identity:string, xml:string, base_spec:any, overlay:any, version:any} | {ok:false, code:string}}
   */
  function loadCurrentState(documentId) {
    const ensured = ensureDocumentDirectory(documentId);
    const pointerRead = readPointer(documentId);
    if (pointerRead.ok !== true) return { ok: false, code: pointerRead.code };
    const pointer = pointerRead.pointer;
    if (pointer.path_identity_digest !== ensured.identity) {
      // The tool-owned document directory was replaced / re-pointed.
      return { ok: false, code: 'OUTCOME_UNKNOWN' };
    }
    const revision = loadRevision(documentId, pointer, ensured.identity);
    if (revision.ok !== true) return { ok: false, code: revision.code };
    return {
      ok: true,
      pointer,
      doc_identity: ensured.identity,
      xml: revision.xml,
      base_spec: revision.base_spec,
      overlay: revision.overlay,
      version: revision.version,
    };
  }

  // -------------------------------------------------------------------------
  // Journal recovery
  // -------------------------------------------------------------------------

  /**
   * @param {string} documentId
   * @param {any} groupEntries
   * @returns {{ok:true, state:string, version?:any} | {ok:false, state:string}}
   */
  function recoverOperation(documentId, groupEntries) {
    const prepared = groupEntries.find((entry) => entry.type === 'prepared');
    const revisionWritten = groupEntries.find((entry) => entry.type === 'revision_written');
    const pointerUpdated = groupEntries.find((entry) => entry.type === 'pointer_updated');
    const saved = groupEntries.find((entry) => entry.type === 'saved');
    if (saved) return { ok: true, state: 'saved', version: saved.version };
    const documentDir = ensureDocumentDirectory(documentId);
    const append = (entry) => appendJournal(documentId, entry, lastJournalSeq(documentId));
    if (!prepared) {
      append({
        type: 'failed',
        operation_id: groupEntries[0]?.operation_id ?? 'unknown',
        document_ref: groupEntries[0]?.document_ref ?? null,
        reason_code: 'RECOVERED_INCONSISTENT',
      });
      return { ok: true, state: 'failed' };
    }
    const operationId = prepared.operation_id;
    // The prepared entry is written before the content digest is known; the
    // revision_written entry carries the authoritative generation / digest.
    const revisionInfo = revisionWritten ?? prepared;
    const generation = revisionInfo.generation;
    const contentSha256 = revisionInfo.content_sha256;
    const byteLength = revisionInfo.byte_length;
    if (!isGeneration(generation) || !isSha256(contentSha256) || !Number.isSafeInteger(byteLength)) {
      if (isGeneration(generation)) {
        // The revision digest is unknown: clean up every file for this
        // generation prefix so a retry never mistakes it for a real revision.
        cleanupPartialRevision(documentId, generation, isSha256(contentSha256) ? contentSha256 : '');
      }
      append({
        type: 'failed',
        operation_id: operationId,
        document_ref: prepared.document_ref ?? null,
        reason_code: 'RECOVERED_INCONSISTENT',
      });
      return { ok: true, state: 'failed' };
    }
    const newVersion = {
      schema_version: 1,
      document_id: documentId,
      generation,
      content_sha256: contentSha256,
      byte_length: byteLength,
      path_identity_digest: documentDir.identity,
    };
    if (revisionWritten) {
      const revision = loadRevision(documentId, newVersion, documentDir.identity);
      if (revision.ok === true) {
        const pointerRead = readPointer(documentId);
        // A replaced document directory must never be legitimized by recovery.
        if (pointerRead.ok === true && pointerRead.pointer.path_identity_digest !== documentDir.identity) {
          return { ok: false, state: 'unknown' };
        }
        const pointerMatchesNew =
          pointerRead.ok === true &&
          pointerRead.pointer.generation === generation &&
          pointerRead.pointer.content_sha256 === contentSha256;
        const pointerStillOld =
          pointerRead.ok === true &&
          prepared.expected_version !== null &&
          prepared.expected_version !== undefined &&
          pointerRead.pointer.generation === prepared.expected_version.generation &&
          pointerRead.pointer.content_sha256 === prepared.expected_version.content_sha256;
        const pointerAbsent = pointerRead.ok !== true && pointerRead.code === 'NOT_FOUND';
        const expectedFromNothing = prepared.expected_version === null || prepared.expected_version === undefined;
        if (pointerMatchesNew) {
          if (!pointerUpdated) append({ type: 'pointer_updated', operation_id: operationId, document_ref: prepared.document_ref ?? null, generation, content_sha256: contentSha256 });
          append({ type: 'saved', operation_id: operationId, document_ref: prepared.document_ref ?? null, status: 'saved', version: newVersion });
          return { ok: true, state: 'saved', version: newVersion };
        }
        if (pointerStillOld || (pointerAbsent && expectedFromNothing)) {
          writePointer(documentId, buildPointer(documentId, operationId, newVersion, generation, contentSha256));
          append({ type: 'pointer_updated', operation_id: operationId, document_ref: prepared.document_ref ?? null, generation, content_sha256: contentSha256 });
          append({ type: 'saved', operation_id: operationId, document_ref: prepared.document_ref ?? null, status: 'saved', version: newVersion });
          return { ok: true, state: 'saved', version: newVersion };
        }
        return { ok: false, state: 'unknown' };
      }
      // revision_written recorded but the files are not intact: fail the op and
      // leave the old pointer untouched.
      cleanupPartialRevision(documentId, generation, contentSha256);
      append({
        type: 'failed',
        operation_id: operationId,
        document_ref: prepared.document_ref ?? null,
        reason_code: 'RECOVERED_INCOMPLETE_REVISION',
      });
      return { ok: true, state: 'failed' };
    }
    // No revision_written entry: the revision may be partially written; never
    // point at it.
    cleanupPartialRevision(documentId, generation, contentSha256);
    append({
      type: 'failed',
      operation_id: operationId,
      document_ref: prepared.document_ref ?? null,
      reason_code: 'RECOVERED_INCOMPLETE_REVISION',
    });
    return { ok: true, state: 'failed' };
  }

  /**
   * Remove temp files and any not-yet-installed revision files for an op.
   * @param {string} documentId
   * @param {number} generation
   * @param {string} contentSha256
   * @returns {void}
   */
  function cleanupPartialRevision(documentId, generation, contentSha256) {
    const dir = revisionsDirectory(documentId);
    const prefix = `${generation}-${contentSha256}`;
    let names;
    try {
      names = fsm.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!String(name).startsWith(prefix) && !String(name).startsWith(`.${prefix}`)) continue;
      try {
        fsm.unlinkSync(path.join(dir, String(name)));
      } catch {
        // best effort; leftover temp files are not referenced by the pointer
      }
    }
  }

  /**
   * Replay the journal for one document. Idempotent; safe to call on every
   * open/save while holding the document lock.
   * @param {string} documentId
   * @returns {{recovered:boolean, states:any[]}}
   */
  function recoverDocument(documentId) {
    const { entries } = readJournal(documentId);
    if (entries.length === 0) return { recovered: false, states: [] };
    /** @type {Map<string, any[]>} */
    const groups = new Map();
    for (const entry of entries) {
      const list = groups.get(entry.operation_id) ?? [];
      list.push(entry);
      groups.set(entry.operation_id, list);
    }
    /** @type {any[]} */
    const states = [];
    let recovered = false;
    for (const groupEntries of groups.values()) {
      const lastType = groupEntries[groupEntries.length - 1].type;
      if (lastType === 'saved' || lastType === 'failed') continue;
      const result = recoverOperation(documentId, groupEntries);
      recovered = true;
      states.push({ operation_id: groupEntries[0].operation_id, ...result });
    }
    return { recovered, states };
  }

  // -------------------------------------------------------------------------
  // Locks
  // -------------------------------------------------------------------------

  /**
   * In-process mutex per document_id (single writer).
   * @param {string} documentId
   * @param {() => any} fn
   * @returns {Promise<any>}
   */
  async function withDocumentMutex(documentId, fn) {
    const previous = documentChains.get(documentId) ?? Promise.resolve();
    /** @type {() => void} */
    let release = () => {};
    const gate = new Promise((resolve) => {
      release = /** @type {any} */ (resolve);
    });
    const tail = previous.then(() => gate);
    documentChains.set(documentId, tail);
    await previous.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
      if (documentChains.get(documentId) === tail) documentChains.delete(documentId);
    }
  }

  /**
   * Cross-process advisory lock file (best effort; see design §8 limitation).
   * @param {string} documentId
   * @returns {{ok:true, release:() => void} | {ok:false, code:string}}
   */
  function acquireFileLock(documentId) {
    const lockPath = path.join(documentDirectory(documentId), 'writer.lock');
    const nonce = randomBytes(8).toString('hex');
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        const handle = fsm.openSync(lockPath, 'wx', 0o600);
        try {
          fsm.writeFileSync(
            handle,
            JSON.stringify({ pid: process.pid, nonce, at: Date.now() }),
          );
          fsm.fsyncSync(handle);
        } finally {
          fsm.closeSync(handle);
        }
        return {
          ok: true,
          release: () => {
            try {
              const raw = fsm.readFileSync(lockPath, 'utf8');
              const parsed = JSON.parse(raw);
              if (parsed?.nonce !== nonce) return;
              fsm.unlinkSync(lockPath);
            } catch {
              // lock already released/cleared
            }
          },
        };
      } catch (error) {
        if (!isFsCode(/** @type {any} */ (error), ['EEXIST'])) return { ok: false, code: 'DOCUMENT_DENIED' };
        /** @type {any} */
        let held = null;
        try {
          held = JSON.parse(fsm.readFileSync(lockPath, 'utf8'));
        } catch {
          held = null;
        }
        const pidAlive = (() => {
          if (!Number.isSafeInteger(held?.pid)) return false;
          try {
            process.kill(held.pid, 0);
            return true;
          } catch (killError) {
            return /** @type {any} */ (killError)?.code === 'EPERM';
          }
        })();
        const stale = !pidAlive || !Number.isFinite(held?.at) || Date.now() - held.at > LOCK_TTL_MS;
        if (stale) {
          try {
            fsm.unlinkSync(lockPath);
          } catch {
            // another process may have won the race; retry
          }
          continue;
        }
        sleepSync(5);
      }
    }
    return { ok: false, code: 'DOCUMENT_DENIED' };
  }

  // -------------------------------------------------------------------------
  // Revision commit
  // -------------------------------------------------------------------------

  /**
   * Write the immutable revision files and atomically install them. Returns the
   * new version (not yet published by the pointer).
   * @param {string} documentId
   * @param {{generation:number, xml:string, base_spec:any, overlay:any, digests:any, operation_id:string}} input
   * @param {string} docIdentity
   * @returns {any} version
   */
  function writeRevisionFiles(documentId, input, docIdentity) {
    const xmlBytes = Buffer.from(input.xml, 'utf8');
    const contentSha256 = sha256Hex(xmlBytes);
    const baseBytes = Buffer.from(canonicalJson(input.base_spec), 'utf8');
    const overlayBytes = Buffer.from(canonicalJson(input.overlay), 'utf8');
    const baseSpecDigest = specDigest(input.base_spec);
    const overlaySha256 = sha256Hex(overlayBytes);
    const revisionManifest = {
      schema_version: 1,
      document_id: documentId,
      generation: input.generation,
      content_sha256: contentSha256,
      byte_length: xmlBytes.length,
      base_spec_digest: baseSpecDigest,
      base_sha256: sha256Hex(baseBytes),
      overlay_sha256: overlaySha256,
      operation_id: input.operation_id,
      created_at: nowIso(),
    };
    const manifestBytes = Buffer.from(canonicalJson(revisionManifest), 'utf8');
    const version = {
      schema_version: 1,
      document_id: documentId,
      generation: input.generation,
      content_sha256: contentSha256,
      byte_length: xmlBytes.length,
      path_identity_digest: docIdentity,
    };
    const paths = revisionPaths(documentId, input.generation, contentSha256);
    fsm.mkdirSync(revisionsDirectory(documentId), { recursive: true });
    const staged = [
      stageFile(fsm, paths.xml, xmlBytes, randomBytes(8).toString('hex')),
      stageFile(fsm, paths.base, baseBytes, randomBytes(8).toString('hex')),
      stageFile(fsm, paths.overlay, overlayBytes, randomBytes(8).toString('hex')),
      stageFile(fsm, paths.manifest, manifestBytes, randomBytes(8).toString('hex')),
    ];
    for (let index = 0; index < staged.length; index += 1) {
      const final = [paths.xml, paths.base, paths.overlay, paths.manifest][index];
      fsm.renameSync(staged[index], final);
    }
    fsyncDirectory(fsm, revisionsDirectory(documentId));
    return { version, contentSha256, xmlBytes, overlaySha256 };
  }

  // -------------------------------------------------------------------------
  // Drafts
  // -------------------------------------------------------------------------

  /**
   * Persist a draft for one editor session and prune to `drafts_retained`.
   * @param {string} documentId
   * @param {any} session
   * @param {string} xml
   * @returns {string | null} draft ref (path relative to the document directory)
   */
  function saveDraft(documentId, session, xml) {
    try {
      const bytes = Buffer.from(xml, 'utf8');
      const digest = sha256Hex(bytes);
      const directory = path.join(documentDirectory(documentId), 'drafts', session.key);
      fsm.mkdirSync(directory, { recursive: true });
      const file = path.join(directory, `${digest}.xml`);
      if (!fsm.existsSync(file)) {
        const temp = stageFile(fsm, file, bytes, randomBytes(8).toString('hex'));
        fsm.renameSync(temp, file);
        fsyncDirectory(fsm, directory);
      }
      pruneDrafts(directory);
      return `drafts/${session.key}/${digest}.xml`;
    } catch {
      return null;
    }
  }

  /**
   * @param {string} directory
   * @returns {void}
   */
  function pruneDrafts(directory) {
    let names;
    try {
      names = fsm.readdirSync(directory);
    } catch {
      return;
    }
    const entries = [];
    for (const name of names) {
      if (!DRAFT_FILE_RE.test(String(name))) continue;
      const file = path.join(directory, String(name));
      let stats;
      try {
        stats = fsm.statSync(file);
      } catch {
        continue;
      }
      entries.push({ file, name: String(name), mtimeMs: stats.mtimeMs });
    }
    entries.sort((left, right) => right.mtimeMs - left.mtimeMs || right.name.localeCompare(left.name));
    const retained = Number.isSafeInteger(limits.drafts_retained) ? limits.drafts_retained : 3;
    for (const entry of entries.slice(retained)) {
      try {
        fsm.unlinkSync(entry.file);
        fsyncDirectory(fsm, path.dirname(entry.file));
      } catch {
        // best effort
      }
    }
  }

  // -------------------------------------------------------------------------
  // Editor sessions
  // -------------------------------------------------------------------------

  /**
   * @param {number} now
   * @param {number} ttl
   * @returns {void}
   */
  function purgeExpiredSessions(now, ttl) {
    for (const [ref, session] of [...sessions.entries()]) {
      if (now >= session.created_at + ttl) sessions.delete(ref);
    }
  }

  /**
   * @param {any} access
   * @param {any} version
   * @param {{kind:'owner', principal_id:string}} caller
   * @returns {any} session
   */
  function createSession(access, version, caller) {
    const now = clockMs();
    const ttl = limits.editor_session_ttl_ms;
    purgeExpiredSessions(now, ttl);
    if (sessions.size >= limits.editor_sessions) {
      throw new DiagramError('LIMIT_EXCEEDED', 'too many editor sessions');
    }
    const editorSessionRef = `es-${randomUUID()}`;
    const session = {
      ref: editorSessionRef,
      key: sha256Hex(editorSessionRef).slice(0, 24),
      document_id: version.document_id,
      document_ref: access.ref,
      generation: version.generation,
      principal_id: caller.principal_id,
      scope_ref: access.entry.scope_ref,
      scope_generation: access.scope_generation,
      channel_nonce: randomBytes(16).toString('hex'),
      created_at: now,
      ttl_ms: ttl,
    };
    sessions.set(editorSessionRef, session);
    return session;
  }

  /**
   * @param {string} editorSessionRef
   * @returns {any | null}
   */
  function readSession(editorSessionRef) {
    const session = sessions.get(editorSessionRef);
    if (!session) return null;
    const now = clockMs();
    if (now >= session.created_at + session.ttl_ms) {
      sessions.delete(editorSessionRef);
      return null;
    }
    return session;
  }

  // -------------------------------------------------------------------------
  // Outcome helpers
  // -------------------------------------------------------------------------

  /**
   * @param {string} status
   * @param {string} code
   * @returns {{status:string, code:string}}
   */
  function coded(status, code) {
    return { status, code };
  }

  // -------------------------------------------------------------------------
  // Artifact package → generation 0
  // -------------------------------------------------------------------------

  /**
   * Read and verify one generated artifact package (index.html is not needed
   * for the document model and is only listed in the manifest).
   * @param {string} artifactRealPath
   * @returns {{ok:true, spec:any, overlay:any, manifest:any, xml:string, warnings:string[]} | {ok:false, code:string}}
   */
  function loadArtifactPackage(artifactRealPath) {
    const warnings = [];
    const manifestRead = readStableFile(path.join(artifactRealPath, 'manifest.json'), {
      maxBytes: 512 * 1024,
    });
    if (manifestRead.ok !== true) return { ok: false, code: manifestRead.code };
    let manifest;
    try {
      manifest = JSON.parse(stripBom(manifestRead.bytes.toString('utf8')));
    } catch {
      return { ok: false, code: 'INVALID_MANIFEST' };
    }
    const manifestValidation = validateManifest(manifest);
    if (manifestValidation.ok !== true) return { ok: false, code: 'INVALID_MANIFEST' };
    /** @type {Map<string, any>} */
    const files = new Map();
    if (Array.isArray(manifest.files)) {
      for (const entry of manifest.files) {
        if (isPlainObject(entry) && typeof entry.relative_path === 'string') files.set(entry.relative_path, entry);
      }
    }
    /**
     * @param {string} relativePath
     * @returns {{ok:true, bytes:Buffer, sha256:string, size:number} | {ok:false, code:string}}
     */
    function readPackageFile(relativePath) {
      const expected = files.get(relativePath);
      if (!expected) return { ok: false, code: 'INVALID_MANIFEST' };
      return readStableFile(path.join(artifactRealPath, relativePath), {
        expectedSha256: expected.sha256,
        expectedSize: expected.size,
        maxBytes: limits.package_bytes,
      });
    }
    const specRead = readPackageFile('diagram-spec.json');
    if (specRead.ok !== true) return { ok: false, code: specRead.code === 'CONFLICT' ? 'INVALID_MANIFEST' : specRead.code };
    let spec;
    try {
      spec = JSON.parse(stripBom(specRead.bytes.toString('utf8')));
    } catch {
      return { ok: false, code: 'INVALID_SPEC' };
    }
    const specValidation = validateDiagramSpec(spec);
    if (specValidation.ok !== true) return { ok: false, code: 'INVALID_SPEC' };
    if (typeof manifest.spec_digest === 'string' && manifest.spec_digest !== specDigest(spec)) {
      return { ok: false, code: 'INVALID_MANIFEST' };
    }
    if (typeof manifest.diagram_id === 'string' && manifest.diagram_id !== spec.diagram_id) {
      return { ok: false, code: 'INVALID_MANIFEST' };
    }
    const overlayRead = readPackageFile('annotations.json');
    if (overlayRead.ok !== true) {
      return { ok: false, code: overlayRead.code === 'CONFLICT' ? 'INVALID_MANIFEST' : overlayRead.code };
    }
    let overlay;
    try {
      overlay = JSON.parse(stripBom(overlayRead.bytes.toString('utf8')));
    } catch {
      return { ok: false, code: 'INVALID_OVERLAY' };
    }
    const overlayValidation = validateOverlay(overlay);
    if (overlayValidation.ok !== true) return { ok: false, code: 'INVALID_OVERLAY' };
    const compositeValidation = validateComposite(spec, overlay);
    if (compositeValidation.ok !== true) return { ok: false, code: 'INVALID_OVERLAY' };
    const xmlRead = readPackageFile('diagram.drawio');
    if (xmlRead.ok !== true) {
      return { ok: false, code: xmlRead.code === 'CONFLICT' ? 'INVALID_MANIFEST' : xmlRead.code };
    }
    const artifactXml = xmlRead.bytes.toString('utf8');
    if (!Buffer.from(artifactXml, 'utf8').equals(xmlRead.bytes)) return { ok: false, code: 'INVALID_XML' };
    const parsedArtifactXml = parseDrawioXml(artifactXml, { limits });
    if (parsedArtifactXml.ok !== true) return { ok: false, code: 'INVALID_XML' };
    const canonical = tryExportDrawio(spec, overlay);
    if (canonical.ok !== true) return { ok: false, code: canonical.code === 'LIMIT_EXCEEDED' ? 'LIMIT_EXCEEDED' : 'UNSUPPORTED' };
    const parsedCanonical = parseDrawioXml(canonical.xml, { limits });
    if (parsedCanonical.ok !== true) return { ok: false, code: 'UNSUPPORTED' };
    if (sameMxGraph(parsedArtifactXml, parsedCanonical) !== true) {
      warnings.push('artifact_xml_canonicalized');
    }
    warnings.push(...canonical.warnings);
    if (typeof manifest.artifact_sha256 === 'string' && manifest.artifact_sha256 !== manifestDigest(manifest)) {
      // The artifact manifest's own digest is advisory here; the consumed files
      // are hash-checked individually above.
      warnings.push('artifact_manifest_digest_mismatch');
    }
    return { ok: true, spec, overlay, manifest, xml: canonical.xml, warnings };
  }

  /**
   * Deterministically export the canonical restricted XML for a validated
   * base+overlay pair; returns a business-coded failure instead of throwing.
   * @param {any} spec
   * @param {any} overlay
   * @returns {{ok:true, xml:string, warnings:string[]} | {ok:false, code:string}}
   */
  function tryExportDrawio(spec, overlay) {
    try {
      const canonical = exportDrawio({ spec, annotation_overlay: overlay }, { limits });
      if (!isPlainObject(canonical) || typeof canonical.xml !== 'string') {
        return { ok: false, code: 'INVALID_OVERLAY' };
      }
      return { ok: true, xml: canonical.xml, warnings: Array.isArray(canonical.warnings) ? canonical.warnings : [] };
    } catch (error) {
      if (isDiagramError(error)) {
        if (error.code === 'LIMIT_EXCEEDED' || error.code === 'INVALID_XML') {
          return { ok: false, code: error.code };
        }
      }
      return { ok: false, code: 'INVALID_OVERLAY' };
    }
  }

  /**
   * Compare two parsed XML payloads by canonical mxGraph semantics.
   * @param {any} parsedLeft
   * @param {any} parsedRight
   * @returns {boolean | null} null when semantic comparison itself failed
   */
  function sameMxGraph(parsedLeft, parsedRight) {
    try {
      return canonicalMxGraph(parsedLeft.document) === canonicalMxGraph(parsedRight.document);
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  function assertStoreUsable() {
    if (disposed) throw new DiagramError('DENIED', 'document store is disposed');
  }

  /**
   * Open one immutable revision and create an editor session for it.
   * @param {{document_ref:string, expected_scope?:{scope_ref:string, scope_generation:number}}} input
   * @param {any} caller
   * @returns {Promise<any>}
   */
  async function openDocument(input, caller) {
    try {
      assertStoreUsable();
      const principal = ownerCaller(caller);
      if (principal === null) return coded('denied', 'OWNER_REQUIRED');
      if (!isPlainObject(input) || typeof input.document_ref !== 'string') {
        return coded('denied', 'CONTEXT_UNBOUND');
      }
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(input.document_ref)) {
        return coded('denied', 'CONTEXT_UNBOUND');
      }
      const expectedScope = isPlainObject(input.expected_scope) ? input.expected_scope : null;
      const entrySnapshot = registry.exportToJson();
      const registered = entrySnapshot.documents.find(
        (entry) => entry.document_ref === input.document_ref && entry.active === true,
      );
      if (!registered) return coded('denied', 'DOCUMENT_DENIED');
      const expectedGeneration =
        expectedScope && isGeneration(expectedScope.scope_generation)
          ? expectedScope.scope_generation
          : callerScopeGeneration(caller) ?? registered.scope_generation;
      if (expectedScope && typeof expectedScope.scope_ref === 'string' && expectedScope.scope_ref !== registered.scope_ref) {
        return coded('denied', 'SCOPE_REVOKED');
      }
      const lookup = registry.lookupDocument(input.document_ref, expectedGeneration);
      if (lookup.ok !== true) {
        return coded('denied', lookup.code === 'DOCUMENT_DENIED' ? 'DOCUMENT_DENIED' : 'SCOPE_REVOKED');
      }
      const documentId = lookup.entry.document_id;
      return await withDocumentMutex(documentId, async () => {
        const ensured = ensureDocumentDirectory(documentId);
        const lock = acquireFileLock(documentId);
        if (lock.ok !== true) return coded('denied', lock.code);
        try {
          const warnings = [];
          const journal = readJournal(documentId);
          if (journal.entries.length > 0) {
            const recovery = recoverDocument(documentId);
            if (recovery.recovered) warnings.push('recovered_operation');
          }
          let state = loadCurrentState(documentId);
          if (state.ok !== true) {
            if (state.code === 'NOT_FOUND' || journal.entries.length === 0) {
              // First open: bootstrap generation 0 from the verified artifact.
              if (!isWithinRoot(dataRoot, ensured.real)) return coded('denied', 'DOCUMENT_DENIED');
              const packagePath = lookup.real_path;
              if (typeof packagePath !== 'string') return coded('unavailable', 'NOT_FOUND');
              const pkg = loadArtifactPackage(packagePath);
              if (pkg.ok !== true) {
                return coded('unavailable', pkg.code);
              }
              const operationId = `bootstrap-${randomBytes(8).toString('hex')}`;
              const commit = commitRevision(documentId, null, {
                generation: 0,
                xml: pkg.xml,
                base_spec: pkg.spec,
                overlay: pkg.overlay,
                operation_id: operationId,
                document_ref: lookup.entry.document_ref,
              });
              if (commit.ok !== true) return coded('unavailable', commit.code);
              state = loadCurrentState(documentId);
              if (state.ok !== true) return coded('unavailable', state.code);
              warnings.push(...pkg.warnings);
            } else {
              return coded('unavailable', state.code);
            }
          }
          const session = createSession(
            { ref: lookup.entry.document_ref, entry: lookup.entry, scope_generation: lookup.entry.scope_generation },
            state.version,
            principal,
          );
          return {
            status: 'opened',
            document_id: documentId,
            xml: state.xml,
            base_spec: state.base_spec,
            overlay: state.overlay,
            version: state.version,
            editor_session_ref: session.ref,
            channel_nonce: session.channel_nonce,
            warnings,
          };
        } finally {
          lock.release();
        }
      });
    } catch (error) {
      if (isDiagramError(error) && error.code === 'DENIED') return coded('denied', 'DOCUMENT_DENIED');
      if (isDiagramError(error) && error.code === 'LIMIT_EXCEEDED') return coded('unavailable', 'LIMIT_EXCEEDED');
      return coded('unavailable', 'INTERNAL_FAILURE');
    }
  }

  /**
   * Write one new immutable revision.
   * @param {{document_id:string, editor_session_ref:string, expected_version:any, xml:string, overlay:any, operation_id:string}} input
   * @param {any} caller
   * @param {AbortSignal} [signal]
   * @returns {Promise<any>}
   */
  async function saveDiagram(input, caller, signal) {
    /** @type {any} */
    let session = null;
    /** @type {string | null} */
    let xmlForDraft = typeof input?.xml === 'string' ? input.xml : null;
    try {
      assertStoreUsable();
      const principal = ownerCaller(caller);
      if (principal === null) return coded('denied', 'OWNER_REQUIRED');
      if (!isPlainObject(input)) return coded('invalid', 'INVALID_INPUT');
      const documentId = input.document_id;
      if (!isDocumentId(documentId)) return coded('invalid', 'INVALID_INPUT');
      if (!isOperationId(input.operation_id)) return coded('invalid', 'INVALID_INPUT');
      if (typeof input.editor_session_ref !== 'string') return coded('denied', 'EDITOR_SESSION_EXPIRED');
      session = readSession(input.editor_session_ref);
      if (!session) return coded('denied', 'EDITOR_SESSION_EXPIRED');
      if (session.principal_id !== principal.principal_id) return coded('denied', 'DOCUMENT_DENIED');
      if (session.document_id !== documentId) return coded('denied', 'DOCUMENT_DENIED');
      const access = resolveDocumentAccess(documentId, caller, 'edit');
      if (access.ok !== true) return coded(access.status, access.code);
      const expectedVersion = input.expected_version;
      if (!isPlainObject(expectedVersion)) return coded('invalid', 'STALE_VERSION');
      const versionValidation = validateDocumentVersion(expectedVersion);
      if (versionValidation.ok !== true) return coded('invalid', 'STALE_VERSION');
      if (expectedVersion.document_id !== documentId) return coded('invalid', 'STALE_VERSION');
      const xml = input.xml;
      if (typeof xml !== 'string') return coded('invalid', 'INVALID_XML');
      if (Buffer.byteLength(xml, 'utf8') > limits.document_xml_bytes) return coded('invalid', 'LIMIT_EXCEEDED');
      xmlForDraft = xml;
      // Idempotency binding: operation_id + document_id + expected_version +
      // exact XML digest + overlay digest. Reusing an operation id with a
      // different body is rejected below, both here and under the lock.
      const binding = {
        operation_id: input.operation_id,
        document_id: documentId,
        expected_version: expectedVersion,
        xml_digest: sha256Hex(Buffer.from(xml, 'utf8')),
        overlay_digest: digestOf(input.overlay ?? null),
      };
      const bindingDigest = digestOf(binding);
      // A completed operation may be replayed by a transport retry even after
      // the session generation advanced (the client never saw the response).
      const replay = findOperation(documentId, input.operation_id);
      if (replay !== null) {
        const prepared = replay.prepared ?? replay.entries[0];
        if (prepared?.editor_session_ref && prepared.editor_session_ref !== session.ref) {
          return coded('denied', 'DOCUMENT_DENIED');
        }
        if (prepared && prepared.binding_digest !== bindingDigest) return coded('invalid', 'CONFLICT');
        const replayState = operationStateFromEntries(replay.entries);
        if (replayState.state === 'saved') return { status: 'saved', version: replayState.version };
        if (replayState.state === 'failed') return coded('invalid', 'FAILED');
      }
      if (session.generation !== expectedVersion.generation) return coded('denied', 'EDITOR_SESSION_EXPIRED');
      if (signal?.aborted === true) {
        const draftRef = saveDraft(documentId, session, xmlForDraft);
        return { status: 'cancelled', code: 'CANCELLED', draft_ref: draftRef };
      }

      return await withDocumentMutex(documentId, async () => {
        const ensured = ensureDocumentDirectory(documentId);
        const lock = acquireFileLock(documentId);
        if (lock.ok !== true) return coded('denied', lock.code);
        try {
          // 1. Recover any interrupted operation first (idempotent).
          recoverDocument(documentId);

          // 2. Idempotency: same operation_id must bind the exact same body
          //    (the journal state may have been completed by recovery above).
          const existing = findOperation(documentId, input.operation_id);
          if (existing !== null) {
            if (existing.prepared && existing.prepared.editor_session_ref !== session.ref) {
              return coded('denied', 'DOCUMENT_DENIED');
            }
            if (existing.prepared && existing.prepared.binding_digest !== bindingDigest) {
              return coded('invalid', 'CONFLICT');
            }
            const operationState = operationStateFromEntries(existing.entries);
            if (operationState.state === 'saved') return { status: 'saved', version: operationState.version };
            if (operationState.state === 'failed') return coded('invalid', 'FAILED');
            return coded('outcome_unknown', 'OUTCOME_UNKNOWN');
          }

          // 3. Current immutable state; tamper / drift detection.
          const state = loadCurrentState(documentId);
          if (state.ok !== true) {
            const draftRef = saveDraft(documentId, session, xml);
            return { status: 'outcome_unknown', code: 'OUTCOME_UNKNOWN', draft_ref: draftRef };
          }
          if (!versionsEqual(state.version, expectedVersion)) {
            const draftRef = saveDraft(documentId, session, xml);
            return { status: 'conflict', current_version: state.version, draft_ref: draftRef };
          }
          if (ensured.identity !== state.version.path_identity_digest) {
            return coded('denied', 'DOCUMENT_DENIED');
          }

          // 4. Schema + semantic validation against the Host's own base.
          const overlayValidation = validateOverlay(input.overlay);
          if (overlayValidation.ok !== true) return coded('invalid', 'INVALID_OVERLAY');
          const compositeValidation = validateComposite(state.base_spec, input.overlay);
          if (compositeValidation.ok !== true) return coded('invalid', 'INVALID_OVERLAY');
          const parsedClientXml = parseDrawioXml(xml, { limits });
          if (parsedClientXml.ok !== true) return coded('invalid', 'INVALID_XML');
          const canonical = tryExportDrawio(state.base_spec, input.overlay);
          if (canonical.ok !== true) return coded('invalid', canonical.code);
          const parsedCanonical = parseDrawioXml(canonical.xml, { limits });
          if (parsedCanonical.ok !== true) return coded('invalid', 'INVALID_OVERLAY');
          const sameGraph = sameMxGraph(parsedClientXml, parsedCanonical);
          if (sameGraph !== true) return coded('invalid', 'INVALID_OVERLAY');
          if (signal?.aborted === true) {
            const draftRef = saveDraft(documentId, session, xml);
            return { status: 'cancelled', code: 'CANCELLED', draft_ref: draftRef };
          }

          // 5. Prepare + write + publish under the same lock.
          const generation = state.version.generation + 1;
          let seq = lastJournalSeq(documentId);
          appendJournal(
            documentId,
            {
              type: 'prepared',
              operation_id: input.operation_id,
              document_ref: session.document_ref,
              editor_session_ref: session.ref,
              binding_digest: bindingDigest,
              xml_digest: binding.xml_digest,
              overlay_digest: binding.overlay_digest,
              expected_version: expectedVersion,
              generation,
              content_sha256: null,
              byte_length: null,
            },
            (seq += 1),
          );
          let written;
          try {
            written = writeRevisionFiles(
              documentId,
              {
                generation,
                xml: canonical.xml,
                base_spec: state.base_spec,
                overlay: input.overlay,
                operation_id: input.operation_id,
              },
              ensured.identity,
            );
          } catch (writeError) {
            const draftRef = saveDraft(documentId, session, xml);
            return { status: 'outcome_unknown', code: 'OUTCOME_UNKNOWN', draft_ref: draftRef };
          }
          const newVersion = written.version;
          appendJournal(
            documentId,
            {
              type: 'revision_written',
              operation_id: input.operation_id,
              document_ref: session.document_ref,
              generation: newVersion.generation,
              content_sha256: newVersion.content_sha256,
              byte_length: newVersion.byte_length,
            },
            (seq += 1),
          );
          if (signal?.aborted === true) {
            journalOperationFailure(documentId, input.operation_id, session.document_ref, 'CANCELLED');
            const draftRef = saveDraft(documentId, session, xml);
            return {
              status: 'cancelled',
              code: 'CANCELLED',
              draft_ref: draftRef,
              current_version: state.version,
            };
          }
          // Critical section: re-check identity, registry, and expected version
          // one last time before the pointer swap.
          const recheckAccess = resolveDocumentAccess(documentId, caller, 'edit');
          if (recheckAccess.ok !== true) {
            journalOperationFailure(documentId, input.operation_id, session.document_ref, 'SCOPE_REVOKED');
            const draftRef = saveDraft(documentId, session, xml);
            return { status: 'denied', code: 'SCOPE_REVOKED', draft_ref: draftRef };
          }
          const recheckState = loadCurrentState(documentId);
          if (recheckState.ok !== true || !versionsEqual(recheckState.version, expectedVersion)) {
            journalOperationFailure(documentId, input.operation_id, session.document_ref, 'STALE_VERSION');
            const current = recheckState.ok === true ? recheckState.version : state.version;
            const draftRef = saveDraft(documentId, session, xml);
            return { status: 'conflict', current_version: current, draft_ref: draftRef };
          }
          writePointer(
            documentId,
            buildPointer(documentId, input.operation_id, newVersion, generation, newVersion.content_sha256),
          );
          appendJournal(
            documentId,
            {
              type: 'pointer_updated',
              operation_id: input.operation_id,
              document_ref: session.document_ref,
              generation,
              content_sha256: newVersion.content_sha256,
            },
            (seq += 1),
          );
          appendJournal(
            documentId,
            {
              type: 'saved',
              operation_id: input.operation_id,
              document_ref: session.document_ref,
              status: 'saved',
              version: newVersion,
            },
            (seq += 1),
          );
          session.generation = newVersion.generation;
          return { status: 'saved', version: newVersion };
        } catch (error) {
          // Any unexpected write-phase failure: old pointer is the only valid
          // state; record a draft and report outcome_unknown (no blind retry).
          const draftRef = session ? saveDraft(documentId, session, xmlForDraft ?? '') : null;
          if (isDiagramError(error)) {
            const map = new Map([
              ['LIMIT_EXCEEDED', ['invalid', 'LIMIT_EXCEEDED']],
              ['DENIED', ['denied', 'DOCUMENT_DENIED']],
            ]);
            const mapped = map.get(error.code);
            if (mapped) return { status: mapped[0], code: mapped[1], draft_ref: draftRef };
          }
          return { status: 'outcome_unknown', code: 'OUTCOME_UNKNOWN', draft_ref: draftRef };
        } finally {
          lock.release();
        }
      });
    } catch (error) {
      if (isDiagramError(error) && error.code === 'DENIED') return coded('denied', 'DOCUMENT_DENIED');
      if (isDiagramError(error) && error.code === 'LIMIT_EXCEEDED') return coded('invalid', 'LIMIT_EXCEEDED');
      return coded('outcome_unknown', 'OUTCOME_UNKNOWN');
    }
  }

  /**
   * @param {string} documentId
   * @param {string} operationId
   * @returns {{entries:any[], prepared?:any} | null}
   */
  function findOperation(documentId, operationId) {
    const { entries } = readJournal(documentId);
    const matches = entries.filter((entry) => entry.operation_id === operationId);
    if (matches.length === 0) return null;
    return {
      entries: matches,
      prepared: matches.find((entry) => entry.type === 'prepared'),
    };
  }

  /**
   * @param {any[]} entries
   * @returns {{state:string, version?:any, reason_code?:string}}
   */
  function operationStateFromEntries(entries) {
    if (!Array.isArray(entries) || entries.length === 0) return { state: 'unknown' };
    const last = entries[entries.length - 1];
    if (last.type === 'saved') return { state: 'saved', version: last.version };
    if (last.type === 'failed') return { state: 'failed', reason_code: last.reason_code ?? 'FAILED' };
    if (last.type === 'pointer_updated' || last.type === 'revision_written') return { state: 'revision_written' };
    if (last.type === 'prepared') return { state: 'pending' };
    return { state: 'unknown' };
  }

  /**
   * @param {any} left
   * @param {any} right
   * @returns {boolean}
   */
  function versionsEqual(left, right) {
    return (
      left?.document_id === right?.document_id &&
      left?.generation === right?.generation &&
      left?.content_sha256 === right?.content_sha256 &&
      left?.byte_length === right?.byte_length &&
      left?.path_identity_digest === right?.path_identity_digest
    );
  }

  /**
   * @param {string} documentId
   * @param {any} expectedVersion
   * @param {{generation:number, xml:string, base_spec:any, overlay:any, operation_id:string, document_ref:string}} content
   * @returns {{ok:true, version:any} | {ok:false, code:string}}
   */
  function commitRevision(documentId, expectedVersion, content) {
    const ensured = ensureDocumentDirectory(documentId);
    let seq = lastJournalSeq(documentId);
    appendJournal(
      documentId,
      {
        type: 'prepared',
        operation_id: content.operation_id,
        document_ref: content.document_ref,
        binding_digest: digestOf({
          operation_id: content.operation_id,
          document_id: documentId,
          expected_version: expectedVersion,
          content_sha256: sha256Hex(Buffer.from(content.xml, 'utf8')),
        }),
        expected_version: expectedVersion,
        generation: content.generation,
        content_sha256: null,
        byte_length: null,
      },
      (seq += 1),
    );
    let written;
    try {
      written = writeRevisionFiles(documentId, content, ensured.identity);
    } catch {
      cleanupPartialRevision(documentId, content.generation, '');
      return { ok: false, code: 'OUTCOME_UNKNOWN' };
    }
    const version = written.version;
    appendJournal(
      documentId,
      {
        type: 'revision_written',
        operation_id: content.operation_id,
        document_ref: content.document_ref,
        generation: version.generation,
        content_sha256: version.content_sha256,
        byte_length: version.byte_length,
      },
      (seq += 1),
    );
    writePointer(documentId, buildPointer(documentId, content.operation_id, version, content.generation, version.content_sha256));
    appendJournal(
      documentId,
      {
        type: 'pointer_updated',
        operation_id: content.operation_id,
        document_ref: content.document_ref,
        generation: version.generation,
        content_sha256: version.content_sha256,
      },
      (seq += 1),
    );
    appendJournal(
      documentId,
      {
        type: 'saved',
        operation_id: content.operation_id,
        document_ref: content.document_ref,
        status: 'saved',
        version,
      },
      (seq += 1),
    );
    return { ok: true, version };
  }

  /**
   * Export one immutable revision to a registered output root using exclusive
   * create (never overwrites an existing file).
   * @param {{document_id:string, version:any, output_ref:string, format:string}} input
   * @param {any} caller
   * @returns {Promise<any>}
   */
  async function exportArtifact(input, caller) {
    try {
      assertStoreUsable();
      const principal = ownerCaller(caller);
      if (principal === null) return coded('denied', 'OWNER_REQUIRED');
      if (!isPlainObject(input)) return coded('invalid', 'INVALID_INPUT');
      const documentId = input.document_id;
      if (!isDocumentId(documentId)) return coded('invalid', 'INVALID_INPUT');
      if (!FORMATS.includes(input.format)) return coded('invalid', 'UNSUPPORTED');
      if (typeof input.output_ref !== 'string') return coded('denied', 'CONTEXT_UNBOUND');
      const requestedVersion = input.version;
      if (!isPlainObject(requestedVersion)) return coded('invalid', 'STALE_VERSION');
      const requestedValidation = validateDocumentVersion(requestedVersion);
      if (requestedValidation.ok !== true) return coded('invalid', 'STALE_VERSION');
      if (requestedVersion.document_id !== documentId) return coded('invalid', 'STALE_VERSION');
      const access = resolveDocumentAccess(documentId, caller, 'any');
      if (access.ok !== true) return coded(access.status, access.code);
      const expectedGeneration = callerScopeGeneration(caller) ?? access.scope_generation;
      const outputLookup = registry.lookupOutputRoot(input.output_ref, expectedGeneration);
      if (outputLookup.ok !== true) return coded('denied', 'DOCUMENT_DENIED');
      const outputRoot = outputLookup.real_path;
      return await withDocumentMutex(documentId, async () => {
        const lock = acquireFileLock(documentId);
        if (lock.ok !== true) return coded('denied', lock.code);
        try {
          recoverDocument(documentId);
          const state = loadCurrentState(documentId);
          if (state.ok !== true) return coded('invalid', 'OUTCOME_UNKNOWN');
          if (!versionsEqual(requestedVersion, state.version)) {
            // Export is defined over the current immutable revision only; a
            // stale token never re-reads a newer revision behind the caller.
            return coded('invalid', 'STALE_VERSION');
          }
          const image = revisionPaths(documentId, state.version.generation, state.version.content_sha256);
          /** @type {Buffer} */
          let bytes;
          if (input.format === 'drawio') {
            const xmlRead = readStableFile(image.xml, {
              expectedSha256: state.version.content_sha256,
              expectedSize: state.version.byte_length,
              maxBytes: limits.document_xml_bytes,
            });
            if (xmlRead.ok !== true) return coded('invalid', 'OUTCOME_UNKNOWN');
            const parsed = parseDrawioXml(xmlRead.bytes.toString('utf8'), { limits });
            if (parsed.ok !== true) return coded('invalid', 'INVALID_XML');
            const canonical = tryExportDrawio(state.base_spec, state.overlay);
            if (canonical.ok !== true) return coded('invalid', canonical.code);
            bytes = Buffer.from(canonical.xml, 'utf8');
          } else if (input.format === 'json') {
            const json = {
              schema_version: 1,
              document_id: documentId,
              generation: state.version.generation,
              content_sha256: state.version.content_sha256,
              base_spec: state.base_spec,
              overlay: state.overlay,
            };
            bytes = Buffer.from(`${canonicalJson(json)}\n`, 'utf8');
          } else {
            try {
              const layoutModule = await import('../layout.mjs');
              const svgModule = await import('../render-svg.mjs');
              const layout = layoutModule.layoutDiagram(state.base_spec);
              const rendered = svgModule.renderSvg(state.base_spec, { overlay: state.overlay, layout });
              bytes = Buffer.from(String(rendered.svg), 'utf8');
            } catch {
              return coded('invalid', 'UNSUPPORTED');
            }
          }
          const extension = input.format === 'drawio' ? 'drawio' : input.format === 'json' ? 'json' : 'svg';
          const fileName = `diagram-${documentId}-g${state.version.generation}.${extension}`;
          const target = path.join(outputRoot, fileName);
          if (!isWithinRoot(outputRoot, path.dirname(target)) || leafFileName(target) !== fileName) {
            return coded('denied', 'DOCUMENT_DENIED');
          }
          /** @type {number} */
          let handle;
          try {
            handle = fsm.openSync(target, 'wx', 0o600);
          } catch (error) {
            if (isFsCode(/** @type {any} */ (error), ['EEXIST'])) return coded('conflict', 'CONFLICT');
            return coded('denied', 'DOCUMENT_DENIED');
          }
          try {
            fsm.writeFileSync(handle, bytes);
            fsm.fsyncSync(handle);
          } catch {
            try {
              fsm.closeSync(handle);
            } catch {
              // ignore
            }
            try {
              fsm.unlinkSync(target);
            } catch {
              // ignore
            }
            return coded('invalid', 'OUTCOME_UNKNOWN');
          }
          fsm.closeSync(handle);
          return {
            status: 'exported',
            artifact_ref: target,
            sha256: sha256Hex(bytes),
            size_bytes: bytes.length,
          };
        } finally {
          lock.release();
        }
      });
    } catch (error) {
      if (isDiagramError(error) && error.code === 'DENIED') return coded('denied', 'DOCUMENT_DENIED');
      return coded('invalid', 'INTERNAL_FAILURE');
    }
  }

  /**
   * @param {{operation_ref:string}} input
   * @param {any} caller
   * @returns {Promise<any>}
   */
  async function getOperation(input, caller) {
    try {
      const principal = ownerCaller(caller);
      if (principal === null) return { state: 'unknown', reason_code: 'OWNER_REQUIRED' };
      if (!isPlainObject(input) || !isOperationId(input.operation_ref)) {
        return { state: 'unknown', reason_code: 'INVALID_INPUT' };
      }
      const documentsDirectory = path.join(dataRoot, 'documents');
      let names;
      try {
        names = fsm.readdirSync(documentsDirectory);
      } catch {
        names = [];
      }
      let scanned = 0;
      for (const name of names) {
        if (scanned >= limits.journal_entries_scan) break;
        if (!isDocumentId(name)) continue;
        scanned += 1;
        const { entries } = readJournal(name);
        const matches = entries.filter((entry) => entry.operation_id === input.operation_ref);
        if (matches.length === 0) continue;
        const state = operationStateFromEntries(matches);
        if (state.state === 'saved') {
          // The operation is only visible to callers that still have access to
          // its document.
          const access = resolveDocumentAccess(name, caller, 'any');
          if (access.ok !== true) return { state: 'unknown', reason_code: 'DOCUMENT_DENIED' };
          return { state: 'saved', version: state.version };
        }
        if (state.state === 'failed') return { state: 'failed', reason_code: state.reason_code };
        return { state: state.state };
      }
      return { state: 'unknown' };
    } catch {
      return { state: 'unknown', reason_code: 'INTERNAL_FAILURE' };
    }
  }

  /**
   * @param {{editor_session_ref:string}} input
   * @param {any} caller
   * @returns {Promise<{closed:boolean}>}
   */
  async function closeEditorSession(input, caller) {
    const principal = ownerCaller(caller);
    if (principal === null) return { closed: false };
    if (!isPlainObject(input) || typeof input.editor_session_ref !== 'string') return { closed: false };
    const session = readSession(input.editor_session_ref);
    if (!session) return { closed: false };
    if (session.principal_id !== principal.principal_id) return { closed: false };
    sessions.delete(input.editor_session_ref);
    return { closed: true };
  }

  /** Sanitized snapshot: never contains absolute paths. */
  function snapshot() {
    /** @type {any[]} */
    const documents = [];
    let names = [];
    try {
      names = fsm.readdirSync(path.join(dataRoot, 'documents'));
    } catch {
      names = [];
    }
    for (const name of names) {
      if (!isDocumentId(name)) continue;
      const pointerRead = readPointer(name);
      const sessionCount = [...sessions.values()].filter((session) => session.document_id === name).length;
      if (pointerRead.ok !== true) {
        documents.push({ document_id: name, generation: null, sessions: sessionCount });
        continue;
      }
      documents.push({
        document_id: name,
        generation: pointerRead.pointer.generation,
        content_sha256: pointerRead.pointer.content_sha256,
        byte_length: pointerRead.pointer.byte_length,
        sessions: sessionCount,
      });
    }
    documents.sort((left, right) => left.document_id.localeCompare(right.document_id));
    return {
      schema_version: 1,
      documents,
      session_count: sessions.size,
      data_root_identity: dataRootIdentity,
    };
  }

  /** Drop all editor sessions (plugin unload / revoke). */
  function dispose() {
    disposed = true;
    sessions.clear();
    return Promise.resolve();
  }

  return {
    openDocument,
    saveDiagram,
    exportArtifact,
    getOperation,
    closeEditorSession,
    snapshot,
    dispose,
    /** Test/inspection seam only: sanitized. */
    dataRootIdentity,
  };
}

