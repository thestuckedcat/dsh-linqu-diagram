/**
 * 06 local diagrams — source lock (DIA-05 trust boundary, T3).
 *
 * `source-lock.json` records *identity* for the fixed sources this capability
 * builds on: what was investigated, what was actually adopted byte-wise, which
 * absolute executables may be spawned, and which evidence documents justify
 * the lock. It is a policy file, not a package manager: nothing here fetches,
 * installs, upgrades, or executes a source.
 *
 * Honesty rules enforced here:
 * - a source is "adopted" only when it lists at least one `adopted_files`
 *   entry; every investigation-only source (`adopted_files: []`) is reported
 *   as `not_adopted` and must never be presented as merged/vendored;
 * - an adopted source must pin `artifact_sha256`, `license`, `license_ref`,
 *   and (for adoption proof) a `resource_manifest_ref`;
 * - `verifyLockedFiles` recomputes every adopted file's sha256 from bytes under
 *   `root` and never trusts the manifest or lock text as proof;
 * - `executorFor` returns null for any command that is absent or malformed, so
 *   an unregistered/edited command cannot reach a process spawn.
 *
 * `artifact_sha256` for an adopted source is the *tree digest* of its adopted
 * files: sha256 over canonical JSON of `[{path, sha256}]` sorted by path, where
 * `path` uses forward slashes (see `treeDigestOf`). Per-file byte digests are
 * pinned by the resource manifest (the manifest that ships with the adopted
 * artifact). Both layers are re-derived here; neither is trusted as text.
 *
 * Known seam: the design text names `schemas/source-lock.schema.json` as the
 * authoritative schema, but this deliverable keeps the strict schema in this
 * module (no JSON file was assigned to the outlet write scope). The schema is
 * exported so tools and reviews can inspect it.
 */

import { readFileSync, lstatSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';

import { LIMITS } from './limits.mjs';
import { canonicalJson, sha256Hex } from './canonical.mjs';
import { validateSchema } from './schema.mjs';

/** Relative path of the repository lock file, under the project root. */
export const SOURCE_LOCK_FILENAME = 'source-lock.json';

const HEX64_PATTERN = '^[0-9a-f]{64}$';
// Structural patterns mirror the authoritative `schemas/source-lock.schema.json`
// (owned by the contracts task) so both validators accept the same lock file.
// Outlet strictness lives in `validateSourceLock` semantics, not in a second
// incompatible structural dialect.
const ID_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._:/@+~=-]*$';
const KIND_PATTERN = '^[a-z][a-z0-9-]*$';

/**
 * Environment variables that must never be supplied to a locked executor:
 * code-injection hooks, proxy/redirect controls, credential-shaped names, or
 * the runner-fixed update-check switch. The runner sets
 * `ARCHIFY_UPDATE_CHECK_DISABLED=1` itself and refuses caller overrides.
 */
const FORBIDDEN_ENV_KEYS = Object.freeze([
  'NODE_OPTIONS',
  'NODE_PATH',
  'NODE_EXTRA_CA_CERTS',
  'NODE_TLS_REJECT_UNAUTHORIZED',
  'ELECTRON_RUN_AS_NODE',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'ARCHIFY_UPDATE_CHECK_DISABLED',
]);

const FORBIDDEN_ENV_PATTERNS = Object.freeze([
  /^NODE_/,
  /^ELECTRON_/,
  /^LD_/,
  /^DYLD_/,
  /PROXY$/i,
  /_(?:KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|CREDENTIALS)$/i,
]);

/**
 * True when an executor environment key is forbidden by outlet policy.
 * Case-insensitive: environment names must not be smuggled in with different
 * casing on platforms whose environment blocks are case-insensitive.
 */
export function isForbiddenEnvKey(key) {
  if (typeof key !== 'string' || key.length === 0) return true;
  const upper = key.toUpperCase();
  if (FORBIDDEN_ENV_KEYS.some((forbidden) => forbidden.toUpperCase() === upper)) return true;
  return FORBIDDEN_ENV_PATTERNS.some((pattern) => pattern.test(upper));
}

/**
 * True for an absolute *local* executable path. UNC/network shares (`\\host`)
 * are rejected: the runner may only spawn bytes from the local filesystem.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isAbsoluteLocalPath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024) return false;
  if (/[\u0000-\u001f]/.test(value)) return false;
  if (value.startsWith('\\\\')) return false; // UNC share, not local
  if (path.win32.isAbsolute(value)) return true;
  return path.posix.isAbsolute(value);
}

/**
 * True for a normalized, root-relative reference path inside the workspace.
 * Rejects drive letters, URL schemes, absolute paths, empty/`.`/`..` segments,
 * backslash-separated escapes, control characters, and over-long paths.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidRelativeRef(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (value.length > LIMITS.relative_path_length) return false;
  if (/[\u0000-\u001f]/.test(value)) return false;
  if (/^[A-Za-z]:/.test(value)) return false; // Windows drive path
  if (value.startsWith('/') || value.startsWith('\\')) return false;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) return false; // URL scheme
  const segments = value.split(/[\\/]/);
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return false;
  return true;
}

/**
 * Resolve `relativeRef` under `root` and prove the result stays inside it.
 * Lexical containment only; symlinks are rejected separately by callers that
 * read bytes.
 * @param {string} root absolute root directory
 * @param {string} relativeRef
 * @returns {{ok:true, absolute:string} | {ok:false}}
 */
function resolveInsideRoot(root, relativeRef) {
  const rootAbs = path.resolve(root);
  const absolute = path.resolve(rootAbs, relativeRef);
  const relative = path.relative(rootAbs, absolute);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return { ok: false };
  return { ok: true, absolute };
}

const nullableString = (maxLength) => ({ type: ['string', 'null'], minLength: 1, maxLength });

const sha256OrNull = { type: ['string', 'null'], minLength: 64, maxLength: 64, pattern: HEX64_PATTERN };

const sourceSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'kind',
    'repository',
    'commit',
    'version',
    'package',
    'artifact_sha256',
    'license',
    'license_ref',
    'adopted_files',
    'resource_manifest_ref',
  ],
  properties: {
    id: { type: 'string', minLength: 1, maxLength: 128, pattern: ID_PATTERN },
    kind: { type: 'string', minLength: 1, maxLength: 64, pattern: KIND_PATTERN },
    repository: { type: 'string', minLength: 1, maxLength: 1024 },
    commit: { type: ['string', 'null'], minLength: 7, maxLength: 64, pattern: '^[0-9a-f]{7,64}$' },
    version: { type: 'string', minLength: 1, maxLength: 256 },
    package: nullableString(256),
    artifact_sha256: sha256OrNull,
    license: nullableString(256),
    license_ref: nullableString(1024),
    adopted_files: {
      type: 'array',
      maxItems: 1024,
      uniqueItems: true,
      items: { type: 'string', minLength: 1, maxLength: LIMITS.relative_path_length },
    },
    resource_manifest_ref: nullableString(1024),
    // Non-v1 annotation: allowed as a human note only, never as adoption proof.
    note: { type: 'string', minLength: 1, maxLength: 1024 },
  },
};

const commandSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'executable_ref', 'args_template', 'env_fixed'],
  properties: {
    id: { type: 'string', minLength: 1, maxLength: 128, pattern: ID_PATTERN },
    executable_ref: { type: 'string', minLength: 1, maxLength: 1024 },
    args_template: {
      type: 'array',
      maxItems: 64,
      items: { type: 'string', maxLength: 1024 },
    },
    env_fixed: {
      type: 'object',
      additionalProperties: { type: 'string', maxLength: 1024 },
    },
  },
};

/**
 * Strict `source-lock.json` v1 schema (JSON-Schema subset understood by
 * `src/schema.mjs`). `additionalProperties: false` everywhere; the only
 * tolerated extension is an optional plain-text `note` on a source, because the
 * repository lock file carries one. It has no trust meaning.
 *
 * Structural patterns mirror `schemas/source-lock.schema.json` (contracts task)
 * so both validators accept the repository lock and ordinary lock edits; this
 * module adds outlet *semantics* on top (network none, path safety, adoption
 * proof, absolute executables). The source `note` field is optional here and in
 * the shared schema; the source `version` field is required here because every
 * investigated source must state what version it refers to.
 */
export const SOURCE_LOCK_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['schema_version', 'runtime', 'sources', 'commands', 'evidence_refs', 'limits'],
  properties: {
    schema_version: { const: 1 },
    runtime: {
      type: 'object',
      additionalProperties: false,
      required: ['node', 'tested_node', 'tested_node_sha256', 'host_node', 'package_manager'],
      properties: {
        node: { type: 'string', minLength: 1, maxLength: 64 },
        tested_node: { type: ['string', 'null'], minLength: 1, maxLength: 64 },
        tested_node_sha256: sha256OrNull,
        host_node: { type: ['string', 'null'], minLength: 1, maxLength: 64 },
        package_manager: { type: 'string', minLength: 1, maxLength: 256 },
      },
    },
    host: {
      type: 'object',
      additionalProperties: false,
      required: [
        'product',
        'version',
        'electron',
        'host_protocol_version',
        'app_asar_sha256',
        'installed_checkout',
        'verified_interfaces',
      ],
      properties: {
        product: { type: 'string', minLength: 1, maxLength: 128 },
        version: { type: 'string', minLength: 1, maxLength: 64 },
        electron: { type: ['string', 'null'], minLength: 1, maxLength: 64 },
        host_protocol_version: { type: 'integer', minimum: 0 },
        app_asar_sha256: sha256OrNull,
        installed_checkout: { type: 'string', minLength: 1, maxLength: 1024 },
        verified_interfaces: {
          type: 'array',
          maxItems: 64,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['module', 'sha256', 'mechanism', 'adopted'],
            properties: {
              module: { type: 'string', minLength: 1, maxLength: 512 },
              sha256: sha256OrNull,
              mechanism: { type: 'string', minLength: 1, maxLength: 1024 },
              adopted: { type: 'string', minLength: 1, maxLength: 256 },
            },
          },
        },
      },
    },
    sources: { type: 'array', minItems: 0, maxItems: 64, items: sourceSchema },
    commands: { type: 'array', maxItems: 64, items: commandSchema },
    evidence_refs: {
      type: 'array',
      minItems: 1,
      maxItems: 64,
      uniqueItems: true,
      items: { type: 'string', minLength: 1, maxLength: 512 },
    },
    limits: {
      type: 'object',
      additionalProperties: false,
      required: ['network_mode', 'remote_services', 'model_services', 'credential_access'],
      properties: {
        network_mode: { const: 'none' },
        remote_services: { type: 'array', maxItems: 64, items: { type: 'string', minLength: 1, maxLength: 256 } },
        model_services: { type: 'array', maxItems: 64, items: { type: 'string', minLength: 1, maxLength: 256 } },
        credential_access: { type: 'boolean' },
      },
    },
  },
});

/**
 * Validate a command's non-schemaable rules (absolute local executable,
 * environment hygiene). Returns issue objects; empty means valid.
 * @param {unknown} command
 * @param {string} pathPrefix
 * @returns {{path:string, keyword:string, message:string}[]}
 */
function commandSemanticIssues(command, pathPrefix) {
  const issues = [];
  if (command === null || typeof command !== 'object') return issues;
  const record = /** @type {Record<string, unknown>} */ (command);

  if (!isAbsoluteLocalPath(record.executable_ref)) {
    issues.push({
      path: `${pathPrefix}.executable_ref`,
      keyword: 'absolute',
      message: 'executable_ref must be an absolute local path (relative paths and UNC shares are rejected)',
    });
  }

  const envFixed = record.env_fixed;
  if (envFixed !== null && typeof envFixed === 'object' && !Array.isArray(envFixed)) {
    const keys = Object.keys(envFixed);
    if (keys.length > LIMITS.executor_env_entries) {
      issues.push({
        path: `${pathPrefix}.env_fixed`,
        keyword: 'limit',
        message: `env_fixed allows at most ${LIMITS.executor_env_entries} entries`,
      });
    }
    for (const key of keys) {
      if (isForbiddenEnvKey(key)) {
        issues.push({
          path: `${pathPrefix}.env_fixed.${key}`,
          keyword: 'forbidden',
          message: 'environment key is forbidden for locked executors (runner fixes ARCHIFY_UPDATE_CHECK_DISABLED itself)',
        });
      }
    }
  }

  const argsTemplate = record.args_template;
  if (Array.isArray(argsTemplate)) {
    for (const [index, arg] of argsTemplate.entries()) {
      if (typeof arg === 'string' && /[\u0000-\u001f]/.test(arg)) {
        issues.push({
          path: `${pathPrefix}.args_template[${index}]`,
          keyword: 'control_character',
          message: 'args_template entries must not contain control characters',
        });
      }
    }
  }

  return issues;
}

/**
 * Semantic validation that JSON schema cannot express.
 *
 * @param {unknown} lock parsed `source-lock.json` value
 * @param {{root?: string|null, requireAdoptionProof?: boolean}} [options]
 *   `root` is only used to prove adopted files exist when
 *   `requireAdoptionProof` is true; validation itself never reads arbitrary
 *   paths and never executes anything.
 * @returns {{ok:boolean, errors:{path:string, keyword:string, message:string}[]}}
 */
export function validateSourceLock(lock, options = {}) {
  const { root = null, requireAdoptionProof = false } = options;
  /** @type {{path:string, keyword:string, message:string}[]} */
  const errors = validateSchema(SOURCE_LOCK_SCHEMA, lock);
  if (errors.length > 0) return { ok: false, errors };

  const typedLock = /** @type {{sources:any[], commands:any[], evidence_refs:string[], limits:any}} */ (lock);

  // Outlet policy beyond the shared structural schema: the capability is
  // offline-only, so declaring remote/model services or credential access is a
  // hard error even though the generic schema can express those fields.
  const limits = typedLock.limits;
  if (Array.isArray(limits.remote_services) && limits.remote_services.length !== 0) {
    errors.push({
      path: '$.limits.remote_services',
      keyword: 'outlet',
      message: 'network_mode is none: remote_services must be empty for this capability',
    });
  }
  if (Array.isArray(limits.model_services) && limits.model_services.length !== 0) {
    errors.push({
      path: '$.limits.model_services',
      keyword: 'outlet',
      message: 'renderer has no model-service dependency: model_services must be empty',
    });
  }
  if (limits.credential_access !== false) {
    errors.push({
      path: '$.limits.credential_access',
      keyword: 'outlet',
      message: 'credential_access must be false for this capability',
    });
  }

  const sourceIds = new Set();
  typedLock.sources.forEach((source, index) => {
    const prefix = `$.sources[${index}]`;
    if (sourceIds.has(source.id)) {
      errors.push({ path: `${prefix}.id`, keyword: 'unique', message: `duplicate source id: ${source.id}` });
    }
    sourceIds.add(source.id);

    const adoptedFiles = Array.isArray(source.adopted_files) ? source.adopted_files : [];
    adoptedFiles.forEach((file, fileIndex) => {
      if (!isValidRelativeRef(file)) {
        errors.push({
          path: `${prefix}.adopted_files[${fileIndex}]`,
          keyword: 'relative_path',
          message: 'adopted_files entries must be root-relative paths without . or .. segments, drive letters, or URL schemes',
        });
      }
    });

    if (source.resource_manifest_ref !== null && !isValidRelativeRef(source.resource_manifest_ref)) {
      errors.push({
        path: `${prefix}.resource_manifest_ref`,
        keyword: 'relative_path',
        message: 'resource_manifest_ref must be a root-relative path',
      });
    }

    if (adoptedFiles.length > 0) {
      if (source.artifact_sha256 === null) {
        errors.push({
          path: `${prefix}.artifact_sha256`,
          keyword: 'adoption',
          message: 'an adopted source must pin artifact_sha256 (tree digest of adopted_files)',
        });
      }
      if (source.license === null) {
        errors.push({
          path: `${prefix}.license`,
          keyword: 'adoption',
          message: 'an adopted source must name an audited license',
        });
      }
      if (source.license_ref === null) {
        errors.push({
          path: `${prefix}.license_ref`,
          keyword: 'adoption',
          message: 'an adopted source must reference its license text',
        });
      }
      if (requireAdoptionProof && source.resource_manifest_ref === null) {
        errors.push({
          path: `${prefix}.resource_manifest_ref`,
          keyword: 'adoption',
          message: 'adoption proof requires a resource manifest that pins per-file sha256',
        });
      }
      if (requireAdoptionProof && typeof root === 'string') {
        for (const [fileIndex, file] of adoptedFiles.entries()) {
          if (!isValidRelativeRef(file)) continue;
          const inside = resolveInsideRoot(root, file);
          if (!inside.ok || !existsSync(inside.absolute)) {
            errors.push({
              path: `${prefix}.adopted_files[${fileIndex}]`,
              keyword: 'exists',
              message: `adopted file is missing under root: ${file}`,
            });
          }
        }
      }
    }
  });

  const commandIds = new Set();
  typedLock.commands.forEach((command, index) => {
    const prefix = `$.commands[${index}]`;
    if (commandIds.has(command.id)) {
      errors.push({ path: `${prefix}.id`, keyword: 'unique', message: `duplicate command id: ${command.id}` });
    }
    commandIds.add(command.id);
    errors.push(...commandSemanticIssues(command, prefix));
  });

  typedLock.evidence_refs.forEach((ref, index) => {
    if (!isValidRelativeRef(ref)) {
      errors.push({
        path: `$.evidence_refs[${index}]`,
        keyword: 'relative_path',
        message: 'evidence_refs entries must be root-relative document paths',
      });
    }
  });

  return { ok: errors.length === 0, errors };
}

/**
 * Tolerate a UTF-8 BOM on JSON text. RFC 8259 permits implementations to
 * ignore a leading BOM; PowerShell redirection on Windows commonly adds one.
 * The BOM is stripped only for parsing; file digests still cover the bytes.
 * @param {string} text
 * @returns {string}
 */
function stripUtf8Bom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Parse and validate `source-lock.json` text. Never throws.
 * @param {string} text
 * @returns {{ok:true, lock:any} | {ok:false, errors:{path:string, keyword:string, message:string}[]}}
 */
export function parseSourceLock(text) {
  if (typeof text !== 'string') {
    return { ok: false, errors: [{ path: '$', keyword: 'type', message: 'source-lock must be JSON text' }] };
  }
  let parsed;
  try {
    parsed = JSON.parse(stripUtf8Bom(text));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, errors: [{ path: '$', keyword: 'json', message: `invalid JSON: ${message}` }] };
  }
  const validation = validateSourceLock(parsed);
  if (!validation.ok) return { ok: false, errors: validation.errors };
  return { ok: true, lock: parsed };
}

/**
 * Return the registered command for `command_id`, or null when the command is
 * absent or fails any safety rule. The result is a copy; callers cannot mutate
 * the lock through it.
 * @param {any} lock parsed lock (see `parseSourceLock`)
 * @param {string} commandId
 * @returns {{id:string, executable_ref:string, args_template:string[], env_fixed:Record<string,string>} | null}
 */
export function executorFor(lock, commandId) {
  if (typeof commandId !== 'string' || commandId.length === 0) return null;
  if (lock === null || typeof lock !== 'object' || !Array.isArray(lock.commands)) return null;
  const command = lock.commands.find((/** @type {any} */ candidate) => candidate !== null && typeof candidate === 'object' && candidate.id === commandId);
  if (command === undefined) return null;
  if (validateSchema(commandSchema, command).length > 0) return null;
  if (commandSemanticIssues(command, '$').length > 0) return null;
  return {
    id: command.id,
    executable_ref: command.executable_ref,
    args_template: [...command.args_template],
    env_fixed: { ...command.env_fixed },
  };
}

/**
 * Deterministic tree identity for adopted file bytes.
 * `sha256` over canonical JSON of `[{path, sha256}]`, sorted by normalized
 * forward-slash path. This is what an adopted source's `artifact_sha256`
 * must equal; it is not a per-file digest.
 * @param {{path:string, sha256:string}[]} files
 * @returns {string} lowercase hex sha256
 */
export function treeDigestOf(files) {
  const normalized = files
    .map((file) => ({ path: String(file.path).replace(/\\/g, '/'), sha256: String(file.sha256) }))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return sha256Hex(canonicalJson(normalized));
}

/**
 * Read a resource manifest and return a `Map<relative_path, sha256>`.
 * The manifest shape is the one used by `src/assets.mjs` artifacts:
 * `{schema_version:1, files:[{relative_path, sha256, size}]}`. Only the digest
 * layer is needed here; size/media-type checks belong to `verifyResourceManifest`.
 * @param {string} absolutePath
 * @returns {{ok:true, entries:Map<string,string>} | {ok:false, message:string}}
 */
function readManifestDigests(absolutePath) {
  let parsed;
  try {
    parsed = JSON.parse(stripUtf8Bom(readFileSync(absolutePath, 'utf8')));
  } catch (error) {
    return { ok: false, message: `cannot read resource manifest: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.files)) {
    return { ok: false, message: 'resource manifest must be an object with a files array' };
  }
  /** @type {Map<string,string>} */
  const entries = new Map();
  for (const file of parsed.files) {
    if (file === null || typeof file !== 'object') continue;
    const relativePath = typeof file.relative_path === 'string' ? file.relative_path.replace(/\\/g, '/') : null;
    const digest = typeof file.sha256 === 'string' ? file.sha256.toLowerCase() : null;
    if (relativePath === null || digest === null || !/^[0-9a-f]{64}$/.test(digest)) {
      return { ok: false, message: 'resource manifest entries require relative_path and a 64-hex sha256' };
    }
    if (entries.has(relativePath)) return { ok: false, message: `duplicate resource manifest entry: ${relativePath}` };
    entries.set(relativePath, digest);
  }
  return { ok: true, entries };
}

/**
 * Recompute adopted-file identity from bytes under `root`.
 *
 * For every source with `adopted_files`:
 * - each listed file must resolve inside `root`, be a regular non-symlink file,
 *   and be readable; its sha256 is recomputed from bytes;
 * - per-file `matches` compares that recomputed digest to the resource
 *   manifest entry (`source.resource_manifest_ref`); a file without a pinned
 *   digest is reported as unpinned and never as matching;
 * - the source tree digest over recomputed bytes must equal
 *   `source.artifact_sha256`.
 *
 * Investigation-only sources (`adopted_files: []`) produce no entries and no
 * claims: they are not adopted.
 *
 * @param {any} lock parsed lock
 * @param {string} root absolute project root that relative refs resolve under
 * @returns {{ok:boolean, files:any[], sources:any[], errors:{path:string, keyword:string, message:string}[]}}
 */
export function verifyLockedFiles(lock, root) {
  /** @type {{path:string, keyword:string, message:string}[]} */
  const errors = [];
  /** @type {any[]} */
  const files = [];
  /** @type {any[]} */
  const sources = [];

  const rootAbs = typeof root === 'string' ? path.resolve(root) : '';
  const validation = validateSourceLock(lock, { root: rootAbs || null });
  if (!validation.ok) return { ok: false, files, sources, errors: validation.errors };
  if (rootAbs === '' || !existsSync(rootAbs) || !statSync(rootAbs).isDirectory()) {
    return {
      ok: false,
      files,
      sources,
      errors: [{ path: 'root', keyword: 'root', message: 'root must be an existing directory' }],
    };
  }

  lock.sources.forEach((/** @type {any} */ source, /** @type {number} */ sourceIndex) => {
    if (!Array.isArray(source.adopted_files) || source.adopted_files.length === 0) {
      sources.push({
        id: source.id,
        status: 'not_adopted',
        adopted_files: 0,
        artifact_sha256: source.artifact_sha256,
        tree_matches: null,
      });
      return;
    }

    /** @type {Map<string,string> | null} */
    let manifestEntries = null;
    if (source.resource_manifest_ref !== null) {
      const manifestInside = resolveInsideRoot(rootAbs, source.resource_manifest_ref);
      if (!manifestInside.ok) {
        errors.push({
          path: `$.sources[${sourceIndex}].resource_manifest_ref`,
          keyword: 'containment',
          message: 'resource_manifest_ref resolves outside root',
        });
      } else {
        const manifest = readManifestDigests(manifestInside.absolute);
        if (!manifest.ok) {
          errors.push({
            path: `$.sources[${sourceIndex}].resource_manifest_ref`,
            keyword: 'manifest',
            message: manifest.message,
          });
        } else {
          manifestEntries = manifest.entries;
        }
      }
    }

    /** @type {{path:string, sha256:string}[]} */
    const recomputed = [];
    for (const relativeRef of source.adopted_files) {
      const normalized = String(relativeRef).replace(/\\/g, '/');
      const inside = resolveInsideRoot(rootAbs, relativeRef);
      if (!inside.ok) {
        errors.push({ path: normalized, keyword: 'containment', message: 'adopted file resolves outside root' });
        files.push({ source_id: source.id, path: normalized, sha256: null, size: null, expected_sha256: null, matches: false });
        continue;
      }
      let fileStat;
      try {
        fileStat = lstatSync(inside.absolute);
      } catch {
        errors.push({ path: normalized, keyword: 'missing', message: 'adopted file is missing under root' });
        files.push({ source_id: source.id, path: normalized, sha256: null, size: null, expected_sha256: null, matches: false });
        continue;
      }
      if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
        errors.push({ path: normalized, keyword: 'file_type', message: 'adopted file must be a regular non-symlink file' });
        files.push({ source_id: source.id, path: normalized, sha256: null, size: null, expected_sha256: null, matches: false });
        continue;
      }
      let bytes;
      try {
        bytes = readFileSync(inside.absolute);
      } catch {
        errors.push({ path: normalized, keyword: 'unreadable', message: 'adopted file could not be read' });
        files.push({ source_id: source.id, path: normalized, sha256: null, size: null, expected_sha256: null, matches: false });
        continue;
      }
      const digest = sha256Hex(bytes);
      recomputed.push({ path: normalized, sha256: digest });
      const expected = manifestEntries ? manifestEntries.get(normalized) ?? null : null;
      const matches = expected !== null && expected === digest;
      files.push({
        source_id: source.id,
        path: normalized,
        sha256: digest,
        size: bytes.length,
        expected_sha256: expected,
        matches,
      });
      if (expected === null) {
        errors.push({
          path: normalized,
          keyword: 'unpinned',
          message: 'adopted file has no pinned digest in the resource manifest; bytes are recomputed but not verified',
        });
      } else if (!matches) {
        errors.push({
          path: normalized,
          keyword: 'digest_mismatch',
          message: `adopted file sha256 does not match the resource manifest (recomputed ${digest})`,
        });
      }
    }

    const recomputedTree = treeDigestOf(recomputed);
    const treePinned = typeof source.artifact_sha256 === 'string';
    const treeMatches = treePinned && recomputedTree === source.artifact_sha256;
    if (!treePinned) {
      errors.push({
        path: `$.sources[${sourceIndex}].artifact_sha256`,
        keyword: 'unpinned',
        message: 'adopted source has no pinned tree digest',
      });
    } else if (!treeMatches) {
      errors.push({
        path: `$.sources[${sourceIndex}].artifact_sha256`,
        keyword: 'tree_digest_mismatch',
        message: `adopted tree digest does not match the lock (recomputed ${recomputedTree})`,
      });
    }
    sources.push({
      id: source.id,
      status: 'adopted',
      adopted_files: source.adopted_files.length,
      artifact_sha256: source.artifact_sha256,
      recomputed_tree_digest: recomputedTree,
      tree_matches: treeMatches,
    });
  });

  return { ok: errors.length === 0, files, sources, errors };
}

/**
 * Report adoption status for every source. Investigation-only sources are
 * `not_adopted`; this function never uses the word "merged" and never treats a
 * declared file list as verified bytes (call `verifyLockedFiles` for that).
 * @param {any} lock parsed lock
 * @returns {{adopted_count:number, not_adopted_count:number, sources:{id:string, kind:string, status:'adopted'|'not_adopted', adopted_files:string[], artifact_sha256:string|null, artifact_pinned:boolean, license:string|null, note:string|null}[]}}
 */
export function adoptionSummary(lock) {
  const sourceList = lock !== null && typeof lock === 'object' && Array.isArray(lock.sources) ? lock.sources : [];
  const sources = sourceList.map((/** @type {any} */ source) => {
    const adoptedFiles = Array.isArray(source?.adopted_files) ? source.adopted_files.slice() : [];
    const adopted = adoptedFiles.length > 0;
    return {
      id: source?.id ?? '(missing id)',
      kind: source?.kind ?? '(missing kind)',
      status: adopted ? 'adopted' : 'not_adopted',
      adopted_files: adoptedFiles,
      artifact_sha256: typeof source?.artifact_sha256 === 'string' ? source.artifact_sha256 : null,
      artifact_pinned: typeof source?.artifact_sha256 === 'string',
      license: typeof source?.license === 'string' ? source.license : null,
      note: typeof source?.note === 'string' ? source.note : null,
    };
  });
  return {
    adopted_count: sources.filter((source) => source.status === 'adopted').length,
    not_adopted_count: sources.filter((source) => source.status === 'not_adopted').length,
    sources,
  };
}
