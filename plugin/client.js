/**
 * dsh-local-diagrams client bundle - GENERATED FILE, DO NOT EDIT.
 *
 * Source: ui/client-entry.mjs and the modules it imports (ui/*.mjs and the
 * selected pure src/ modules). Rebuild with `node tools/build-client.mjs`;
 * `node tools/build-client.mjs --check` fails when this file is stale.
 *
 * bundle id: dsh-local-diagrams
 * tool version: 1
 * sources sha256: dc4605781555144d597383ec844f37c79dad9e655d2fa5a87f226b7f49016a4e
 * externals: react
 */
window.__ModuleLoader__.load({
	id: "dsh-local-diagrams",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		// Minimal browser-safe Buffer surface used by src/canonical.mjs.
		var Buffer = { byteLength: __utf8ByteLength };
		function __utf8ByteLength(text) {
			let bytes = 0;
			for (let index = 0; index < text.length; index += 1) {
				const code = text.charCodeAt(index);
				if (code < 0x80) bytes += 1;
				else if (code < 0x800) bytes += 2;
				else if (code >= 0xd800 && code <= 0xdbff) {
					bytes += 4;
					index += 1;
				} else bytes += 3;
			}
			return bytes;
		}
		var __definitions = Object.create(null);
		var __cache = Object.create(null);
		__definitions["src/canonical.mjs"] = function (module, exports, __require) {
const { createHash } = __require("ui/hash.mjs");

/**
 * Deterministic canonical JSON: object keys sorted, array order preserved,
 * JSON primitive semantics only. The caller must have validated the value
 * (no undefined, functions, NaN, Infinity, bigint, symbols) first.
 * @param {unknown} value
 * @returns {string}
 */
function canonicalJson(value) {
  return JSON.stringify(sortValue(value));
}

/** @param {unknown} value @returns {unknown} */
function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === 'object') {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortValue(/** @type {any} */ (value)[key]);
    return out;
  }
  return value;
}

/** @param {string | Uint8Array} data @returns {string} lowercase hex sha256 */
function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

/** @param {unknown} value @returns {string} */
function digestOf(value) {
  return sha256Hex(canonicalJson(value));
}

/**
 * Byte length of a UTF-8 string.
 * @param {string} text
 * @returns {number}
 */
function utf8Length(text) {
  return Buffer.byteLength(text, 'utf8');
}

/**
 * Structural equality over canonical JSON.
 * @param {unknown} left
 * @param {unknown} right
 * @returns {boolean}
 */
function canonicalEqual(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

exports.canonicalJson = canonicalJson;
exports.sha256Hex = sha256Hex;
exports.digestOf = digestOf;
exports.utf8Length = utf8Length;
exports.canonicalEqual = canonicalEqual;
		};
		__definitions["src/contracts.mjs"] = function (module, exports, __require) {
/**
 * 06 local diagrams — strict v1 contract schemas and semantic validators.
 *
 * The artifacts under `schemas/*.json` are the authoritative contract files
 * (DIA-DESIGN-2 §4); the JS objects exported from this module are the ones the
 * runtime uses and a test asserts they are deep-equal to the JSON files after
 * normalization. Never add a schema object here without adding its JSON mirror.
 *
 * Conventions (docs/interfaces.md general rules):
 * - validators return `{ok:true, value}` or `{ok:false, errors:[{path,keyword,message}]}`
 *   and never throw on bad data;
 * - constructors/digests throw a stable `DiagramError` code when handed
 *   something that cannot be a valid contract value;
 * - strings are plain text: control characters are rejected, HTML/URL syntax is
 *   never interpreted as data;
 * - no network, no filesystem, no clock here. Timestamps are injected.
 */
const { validateSchema } = __require("src/schema.mjs");
const { canonicalJson, sha256Hex } = __require("src/canonical.mjs");
const { LIMITS, CODES } = __require("src/limits.mjs");
const { fail } = __require("src/errors.mjs");

const JSON_SCHEMA_URI = 'https://json-schema.org/draft/2020-12/schema';

/** Safe document-entity id: 1..128 chars, no whitespace/control/HTML/quote chars. */
const ID_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._:/@+~=-]*$';
/** Lowercase sha256 hex digest. */
const SHA256_HEX_PATTERN = '^[0-9a-f]{64}$';
/** UTC ISO-8601 timestamp as produced by `Date#toISOString()`. */
const TIMESTAMP_PATTERN = '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$';
/** C0 controls except TAB/LF, plus DEL and C1 controls. */
const CONTROL_CHARS_PATTERN = '[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F]';

const ID_REGEX = new RegExp(ID_PATTERN, 'u');
const SHA256_HEX_REGEX = new RegExp(SHA256_HEX_PATTERN, 'u');
const TIMESTAMP_REGEX = new RegExp(TIMESTAMP_PATTERN, 'u');
const CONTROL_CHARS_REGEX = new RegExp(CONTROL_CHARS_PATTERN, 'u');
const RENDERER_REF_REGEX = /^[a-z][a-z0-9-]*:[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const MEDIA_TYPE_REGEX = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u;
const RELATIVE_PATH_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

/** Upper bounds not carried by limits.mjs because they are contract-local. */
const ID_MAX = 128;
const PATH_TEXT_MAX = 1024;
const DIGEST_TEXT_MAX = 256;
const REVISION_TEXT_MAX = 128;
const REGISTRY_MAX_ENTRIES = 1024;
const LOCK_MAX_SOURCES = 64;
const LOCK_MAX_COMMANDS = 64;
const LOCK_MAX_FILES = 1024;

/** Fixed reason-code shape for RPC business responses (see docs/software-design §9). */
const REASON_CODE_PATTERN = '^[A-Z][A-Z0-9_]{0,63}$';

const PATTERNS = Object.freeze({
  id: ID_PATTERN,
  sha256: SHA256_HEX_PATTERN,
  timestamp: TIMESTAMP_PATTERN,
  control_chars: CONTROL_CHARS_PATTERN,
});

/* ------------------------------------------------------------------------- *
 * Schema builders
 * ------------------------------------------------------------------------- */

/**
 * @param {object} schema
 * @returns {object}
 */
function withSchemaUri(schema) {
  return { $schema: JSON_SCHEMA_URI, ...schema };
}

/**
 * @param {number} maxLength
 * @param {number} [minLength]
 */
function idSchema(maxLength = ID_MAX) {
  return { type: 'string', minLength: 1, maxLength, pattern: ID_PATTERN };
}

/**
 * @param {number} maxLength
 * @param {number} [minLength]
 */
function textSchema(maxLength, minLength = 0) {
  return { type: 'string', minLength, maxLength, not: { pattern: CONTROL_CHARS_PATTERN } };
}

/**
 * @param {number} maxLength
 * @param {number} [minLength]
 */
function nullableTextSchema(maxLength, minLength = 0) {
  return {
    anyOf: [{ type: 'null' }, { type: 'string', minLength, maxLength, not: { pattern: CONTROL_CHARS_PATTERN } }],
  };
}

function nullableIdSchema(maxLength = ID_MAX) {
  return { anyOf: [{ type: 'null' }, idSchema(maxLength)] };
}

function timestampSchema() {
  return { type: 'string', pattern: TIMESTAMP_PATTERN };
}

function sha256Schema() {
  return { type: 'string', pattern: SHA256_HEX_PATTERN };
}

function nullableSha256Schema() {
  return { anyOf: [{ type: 'null' }, sha256Schema()] };
}

/** @param {number} [minimum] */
function countSchema(minimum = 0) {
  return { type: 'integer', minimum };
}

function coordinateSchema() {
  return { type: 'integer', minimum: -LIMITS.position_coordinate, maximum: LIMITS.position_coordinate };
}

function sizeSchema() {
  return { type: 'integer', minimum: LIMITS.position_min_size, maximum: LIMITS.position_max_size };
}

function positionSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['x', 'y', 'width', 'height'],
    properties: {
      x: coordinateSchema(),
      y: coordinateSchema(),
      width: sizeSchema(),
      height: sizeSchema(),
    },
  };
}

function evidenceRefSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['evidence_id', 'source_id', 'repo_id', 'path_ref', 'content_digest', 'line_start', 'line_end', 'kind'],
    properties: {
      evidence_id: idSchema(LIMITS.evidence_id),
      source_id: idSchema(LIMITS.source_id),
      repo_id: idSchema(LIMITS.repo_id),
      path_ref: textSchema(PATH_TEXT_MAX, 1),
      content_digest: textSchema(DIGEST_TEXT_MAX, 1),
      line_start: countSchema(1),
      line_end: countSchema(1),
      kind: { enum: ['compiler', 'source', 'runtime', 'user'] },
    },
  };
}

function evidenceRefArraySchema() {
  return { type: 'array', minItems: 0, maxItems: LIMITS.evidence_refs_per_entity, items: evidenceRefSchema() };
}

function repoIdentitySchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: [
      'repo_id',
      'root_ref',
      'revision',
      'dirty_digest',
      'build_variant',
      'arch',
      'compdb_digest',
      'generated_headers_digest',
    ],
    properties: {
      repo_id: idSchema(LIMITS.repo_id),
      root_ref: textSchema(PATH_TEXT_MAX, 1),
      revision: nullableTextSchema(REVISION_TEXT_MAX, 1),
      dirty_digest: textSchema(DIGEST_TEXT_MAX, 1),
      build_variant: textSchema(REVISION_TEXT_MAX, 1),
      arch: textSchema(64, 1),
      compdb_digest: nullableTextSchema(DIGEST_TEXT_MAX, 1),
      generated_headers_digest: nullableTextSchema(DIGEST_TEXT_MAX, 1),
    },
  };
}

function sourceIdentitySchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['source_id', 'scope_ref', 'snapshot_ref', 'repos', 'evidence_manifest_digest'],
    properties: {
      source_id: idSchema(LIMITS.source_id),
      scope_ref: textSchema(LIMITS.scope_ref, 1),
      snapshot_ref: textSchema(LIMITS.snapshot_ref, 1),
      repos: { type: 'array', minItems: 0, maxItems: LIMITS.repos_per_source, items: repoIdentitySchema() },
      evidence_manifest_digest: textSchema(DIGEST_TEXT_MAX, 1),
    },
  };
}

function nodeSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'label', 'kind', 'origin', 'evidence_refs', 'description'],
    properties: {
      id: idSchema(LIMITS.node_id_length),
      label: textSchema(LIMITS.label),
      kind: { enum: ['module', 'function', 'type', 'resource', 'note'] },
      origin: { enum: ['evidence', 'annotation'] },
      evidence_refs: evidenceRefArraySchema(),
      description: nullableTextSchema(LIMITS.description),
    },
  };
}

function edgeSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'from', 'to', 'kind', 'certainty', 'origin', 'label', 'evidence_refs', 'explanation'],
    properties: {
      id: idSchema(LIMITS.edge_id_length),
      from: idSchema(LIMITS.node_id_length),
      to: idSchema(LIMITS.node_id_length),
      kind: { enum: ['call', 'reference', 'data', 'ownership', 'control', 'annotation'] },
      certainty: { enum: ['exact', 'may', 'unresolved', 'unknown'] },
      origin: { enum: ['evidence', 'annotation'] },
      label: textSchema(LIMITS.label),
      evidence_refs: evidenceRefArraySchema(),
      explanation: nullableTextSchema(LIMITS.explanation),
    },
  };
}

function layoutSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['algorithm', 'direction', 'positions'],
    properties: {
      algorithm: { const: 'layered_v1' },
      direction: { enum: ['LR', 'TB'] },
      positions: {
        type: 'array',
        minItems: 0,
        maxItems: LIMITS.nodes,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['node_id', 'x', 'y', 'width', 'height'],
          properties: {
            node_id: idSchema(LIMITS.node_id_length),
            x: coordinateSchema(),
            y: coordinateSchema(),
            width: sizeSchema(),
            height: sizeSchema(),
          },
        },
      },
    },
  };
}

function coverageSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['complete', 'truncated', 'omitted_nodes', 'omitted_edges', 'unresolved_count', 'notes'],
    properties: {
      complete: { const: false },
      truncated: { type: 'boolean' },
      omitted_nodes: countSchema(),
      omitted_edges: countSchema(),
      unresolved_count: countSchema(),
      notes: {
        type: 'array',
        minItems: 0,
        maxItems: LIMITS.coverage_notes,
        items: textSchema(LIMITS.coverage_notes_length),
      },
    },
  };
}

function diagramSpecSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: [
      'schema_version',
      'diagram_id',
      'revision',
      'mode',
      'title',
      'scope_ref',
      'sources',
      'nodes',
      'edges',
      'layout',
      'coverage',
      'source_state',
      'generated_at',
      'renderer_ref',
    ],
    properties: {
      schema_version: { const: 1 },
      diagram_id: idSchema(ID_MAX),
      revision: countSchema(),
      mode: { enum: ['evidence', 'conceptual'] },
      title: textSchema(LIMITS.title, 1),
      scope_ref: textSchema(LIMITS.scope_ref, 1),
      sources: { type: 'array', minItems: 0, maxItems: LIMITS.sources, items: sourceIdentitySchema() },
      nodes: { type: 'array', minItems: 0, maxItems: LIMITS.nodes, items: nodeSchema() },
      edges: { type: 'array', minItems: 0, maxItems: LIMITS.edges, items: edgeSchema() },
      layout: layoutSchema(),
      coverage: coverageSchema(),
      source_state: { enum: ['current', 'stale', 'unknown'] },
      generated_at: timestampSchema(),
      renderer_ref: textSchema(128, 1),
    },
  };
}

function annotationOverlaySchema() {
  const itemSchemas = [
    {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'kind', 'target_ref', 'text', 'position'],
      properties: {
        id: idSchema(LIMITS.overlay_id_length),
        kind: { const: 'note' },
        target_ref: nullableIdSchema(LIMITS.overlay_id_length),
        text: textSchema(LIMITS.description),
        position: positionSchema(),
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'kind', 'label', 'description', 'position'],
      properties: {
        id: idSchema(LIMITS.overlay_id_length),
        kind: { const: 'annotation_node' },
        label: textSchema(LIMITS.label),
        description: nullableTextSchema(LIMITS.description),
        position: positionSchema(),
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'kind', 'from', 'to', 'label', 'description'],
      properties: {
        id: idSchema(LIMITS.overlay_id_length),
        kind: { const: 'annotation_edge' },
        from: idSchema(LIMITS.overlay_id_length),
        to: idSchema(LIMITS.overlay_id_length),
        label: textSchema(LIMITS.label),
        description: nullableTextSchema(LIMITS.description),
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'kind', 'target_ref', 'position'],
      properties: {
        id: idSchema(LIMITS.overlay_id_length),
        kind: { const: 'layout' },
        target_ref: idSchema(LIMITS.overlay_id_length),
        position: positionSchema(),
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'kind', 'target_ref', 'hidden'],
      properties: {
        id: idSchema(LIMITS.overlay_id_length),
        kind: { const: 'visibility' },
        target_ref: idSchema(LIMITS.overlay_id_length),
        hidden: { type: 'boolean' },
      },
    },
  ];
  return {
    type: 'object',
    additionalProperties: false,
    required: ['schema_version', 'diagram_id', 'base_spec_digest', 'revision', 'items', 'orphaned_annotations', 'updated_at'],
    properties: {
      schema_version: { const: 1 },
      diagram_id: idSchema(ID_MAX),
      base_spec_digest: sha256Schema(),
      revision: countSchema(),
      items: { type: 'array', minItems: 0, maxItems: LIMITS.overlay_items, items: { oneOf: itemSchemas } },
      orphaned_annotations: {
        type: 'array',
        minItems: 0,
        maxItems: LIMITS.orphaned_annotations,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['item', 'reason'],
          properties: {
            item: { oneOf: itemSchemas },
            reason: { enum: ['target_missing', 'endpoint_missing'] },
          },
        },
      },
      updated_at: timestampSchema(),
    },
  };
}

function artifactManifestSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: [
      'schema_version',
      'artifact_id',
      'diagram_id',
      'spec_digest',
      'source_digests',
      'renderer_ref',
      'created_at',
      'files',
      'network_mode',
      'source_state',
    ],
    properties: {
      schema_version: { const: 1 },
      artifact_id: idSchema(ID_MAX),
      diagram_id: idSchema(ID_MAX),
      spec_digest: sha256Schema(),
      source_digests: {
        type: 'array',
        minItems: 0,
        maxItems: LIMITS.sources,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['source_id', 'digest'],
          properties: {
            source_id: idSchema(LIMITS.source_id),
            digest: sha256Schema(),
          },
        },
      },
      renderer_ref: textSchema(128, 1),
      created_at: timestampSchema(),
      files: {
        type: 'array',
        minItems: 1,
        maxItems: LIMITS.artifact_files,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['relative_path', 'media_type', 'sha256', 'size'],
          properties: {
            relative_path: {
              type: 'string',
              minLength: 1,
              maxLength: LIMITS.relative_path_length,
              pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$',
            },
            media_type: { type: 'string', minLength: 1, maxLength: ID_MAX, pattern: '^[a-z0-9][a-z0-9!#$&^_.+-]*\\/[a-z0-9][a-z0-9!#$&^_.+-]*$' },
            sha256: sha256Schema(),
            size: { type: 'integer', minimum: 0, maximum: LIMITS.package_bytes },
          },
        },
      },
      network_mode: { const: 'offline' },
      source_state: { enum: ['current', 'stale', 'unknown'] },
    },
  };
}

function documentVersionSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['schema_version', 'document_id', 'generation', 'content_sha256', 'byte_length', 'path_identity_digest'],
    properties: {
      schema_version: { const: 1 },
      document_id: idSchema(ID_MAX),
      generation: countSchema(),
      content_sha256: sha256Schema(),
      byte_length: { type: 'integer', minimum: 0, maximum: LIMITS.document_xml_bytes },
      path_identity_digest: textSchema(DIGEST_TEXT_MAX, 1),
    },
  };
}

function accessRegistrySchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['schema_version', 'revision', 'contexts', 'documents', 'output_roots'],
    properties: {
      schema_version: { const: 1 },
      revision: countSchema(),
      contexts: {
        type: 'array',
        minItems: 0,
        maxItems: REGISTRY_MAX_ENTRIES,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['context_ref', 'scope_ref', 'scope_generation', 'active'],
          properties: {
            context_ref: idSchema(ID_MAX),
            scope_ref: textSchema(LIMITS.scope_ref, 1),
            scope_generation: countSchema(),
            active: { type: 'boolean' },
          },
        },
      },
      documents: {
        type: 'array',
        minItems: 0,
        maxItems: REGISTRY_MAX_ENTRIES,
        items: {
          type: 'object',
          additionalProperties: false,
          required: [
            'document_ref',
            'document_id',
            'scope_ref',
            'scope_generation',
            'path_identity_digest',
            'mode',
            'active',
          ],
          properties: {
            document_ref: idSchema(ID_MAX),
            document_id: idSchema(ID_MAX),
            scope_ref: textSchema(LIMITS.scope_ref, 1),
            scope_generation: countSchema(),
            path_identity_digest: textSchema(DIGEST_TEXT_MAX, 1),
            mode: { enum: ['read', 'edit'] },
            active: { type: 'boolean' },
          },
        },
      },
      output_roots: {
        type: 'array',
        minItems: 0,
        maxItems: REGISTRY_MAX_ENTRIES,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['output_ref', 'scope_ref', 'scope_generation', 'identity_digest', 'active'],
          properties: {
            output_ref: idSchema(ID_MAX),
            scope_ref: textSchema(LIMITS.scope_ref, 1),
            scope_generation: countSchema(),
            identity_digest: textSchema(DIGEST_TEXT_MAX, 1),
            active: { type: 'boolean' },
          },
        },
      },
    },
  };
}

function editorModelSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['schema_version', 'base_spec_digest', 'overlay', 'selection', 'draft_revision', 'dirty'],
    properties: {
      schema_version: { const: 1 },
      base_spec_digest: sha256Schema(),
      overlay: annotationOverlaySchema(),
      selection: { type: 'array', minItems: 0, maxItems: LIMITS.overlay_items, items: idSchema(LIMITS.overlay_id_length) },
      draft_revision: countSchema(),
      dirty: { type: 'boolean' },
    },
  };
}

function rpcRequestSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['schema_version', 'operation_id', 'context_ref', 'expected_scope_generation', 'view_epoch', 'input'],
    properties: {
      schema_version: { const: 1 },
      operation_id: idSchema(LIMITS.rpc_operation_id_length),
      context_ref: idSchema(LIMITS.rpc_context_ref_length),
      expected_scope_generation: countSchema(),
      view_epoch: { type: 'integer', minimum: 0, maximum: LIMITS.rpc_view_epoch_max },
      // Endpoint-specific payload; closed by the endpoint schema in the plugin
      // service (owner: plugin). Never contains caller/grant fields by contract.
      input: { type: 'object' },
    },
  };
}

function rpcResponseSchema() {
  const shell = {
    operation_id: idSchema(LIMITS.rpc_operation_id_length),
    view_epoch: { type: 'integer', minimum: 0, maximum: LIMITS.rpc_view_epoch_max },
    scope_generation: countSchema(),
  };
  const ok = {
    type: 'object',
    additionalProperties: false,
    required: ['schema_version', 'operation_id', 'view_epoch', 'scope_generation', 'status', 'data'],
    properties: {
      schema_version: { const: 1 },
      ...shell,
      status: { const: 'ok' },
      // Endpoint-specific success payload; closed by the endpoint contract.
      data: { type: 'object' },
    },
  };
  const error = {
    type: 'object',
    additionalProperties: false,
    required: ['schema_version', 'operation_id', 'view_epoch', 'scope_generation', 'status', 'reason_code'],
    properties: {
      schema_version: { const: 1 },
      ...shell,
      status: { enum: ['denied', 'stale', 'invalid', 'conflict', 'unavailable', 'failed'] },
      reason_code: { type: 'string', minLength: 1, maxLength: 64, pattern: REASON_CODE_PATTERN },
      // Conflict may expose only the current non-secret version and a granted draft ref.
      data: {
        type: 'object',
        additionalProperties: false,
        required: ['current_version'],
        properties: {
          current_version: documentVersionSchema(),
          draft_ref: idSchema(ID_MAX),
        },
      },
    },
  };
  return { oneOf: [ok, error] };
}

function sourceLockSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['schema_version', 'sources', 'commands', 'evidence_refs'],
    properties: {
      schema_version: { const: 1 },
      runtime: {
        type: 'object',
        additionalProperties: false,
        required: ['node', 'package_manager'],
        properties: {
          node: textSchema(64, 1),
          tested_node: nullableTextSchema(64, 1),
          tested_node_sha256: nullableSha256Schema(),
          host_node: nullableTextSchema(64, 1),
          package_manager: textSchema(DIGEST_TEXT_MAX, 1),
        },
      },
      host: {
        type: 'object',
        additionalProperties: false,
        required: ['product', 'version'],
        properties: {
          product: textSchema(ID_MAX, 1),
          version: textSchema(64, 1),
          electron: nullableTextSchema(64, 1),
          host_protocol_version: countSchema(),
          app_asar_sha256: nullableSha256Schema(),
          installed_checkout: textSchema(PATH_TEXT_MAX, 1),
          verified_interfaces: {
            type: 'array',
            minItems: 0,
            maxItems: LOCK_MAX_COMMANDS,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['module', 'sha256', 'mechanism', 'adopted'],
              properties: {
                module: textSchema(DIGEST_TEXT_MAX, 1),
                sha256: nullableSha256Schema(),
                mechanism: textSchema(PATH_TEXT_MAX, 1),
                adopted: textSchema(DIGEST_TEXT_MAX, 1),
              },
            },
          },
        },
      },
      sources: {
        type: 'array',
        minItems: 0,
        maxItems: LOCK_MAX_SOURCES,
        items: {
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
            id: idSchema(LIMITS.source_id),
            kind: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[a-z][a-z0-9-]*$' },
            repository: textSchema(PATH_TEXT_MAX, 1),
            commit: { anyOf: [{ type: 'null' }, { type: 'string', pattern: '^[0-9a-f]{7,64}$' }] },
            version: nullableTextSchema(DIGEST_TEXT_MAX, 1),
            package: nullableTextSchema(DIGEST_TEXT_MAX, 1),
            artifact_sha256: nullableSha256Schema(),
            license: nullableTextSchema(DIGEST_TEXT_MAX, 1),
            license_ref: nullableTextSchema(PATH_TEXT_MAX, 1),
            adopted_files: { type: 'array', minItems: 0, maxItems: LOCK_MAX_FILES, items: textSchema(LIMITS.relative_path_length, 1) },
            resource_manifest_ref: nullableTextSchema(PATH_TEXT_MAX, 1),
            note: nullableTextSchema(PATH_TEXT_MAX, 1),
          },
        },
      },
      commands: {
        type: 'array',
        minItems: 0,
        maxItems: LOCK_MAX_COMMANDS,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'executable_ref', 'args_template', 'env_fixed'],
          properties: {
            id: idSchema(ID_MAX),
            executable_ref: textSchema(PATH_TEXT_MAX, 1),
            args_template: { type: 'array', minItems: 0, maxItems: LOCK_MAX_COMMANDS, items: textSchema(PATH_TEXT_MAX) },
            env_fixed: { type: 'object', additionalProperties: { type: 'string', maxLength: PATH_TEXT_MAX } },
          },
        },
      },
      evidence_refs: { type: 'array', minItems: 0, maxItems: LOCK_MAX_COMMANDS, items: textSchema(512, 1) },
      limits: {
        type: 'object',
        additionalProperties: false,
        required: ['network_mode'],
        properties: {
          network_mode: { const: 'none' },
          remote_services: { type: 'array', minItems: 0, maxItems: LOCK_MAX_COMMANDS, items: textSchema(DIGEST_TEXT_MAX, 1) },
          model_services: { type: 'array', minItems: 0, maxItems: LOCK_MAX_COMMANDS, items: textSchema(DIGEST_TEXT_MAX, 1) },
          credential_access: { type: 'boolean' },
        },
      },
    },
  };
}

/** Complete editor command union (docs/software-design.md §7). */
const EDITOR_COMMAND_KINDS = Object.freeze([
  'move_node',
  'set_note',
  'add_annotation_node',
  'set_annotation_node',
  'add_annotation_edge',
  'remove_annotation',
  'remove_annotation_node',
  'set_visibility',
  'undo',
  'redo',
]);

function commandEnvelopeSchema(kind, payloadSchema) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['command_id', 'expected_draft_revision', 'kind', 'payload'],
    properties: {
      command_id: idSchema(ID_MAX),
      expected_draft_revision: countSchema(),
      kind: { const: kind },
      payload: payloadSchema,
    },
  };
}

function editorCommandSchema() {
  const emptyPayload = { type: 'object', additionalProperties: false };
  const variants = [
    commandEnvelopeSchema('move_node', {
      type: 'object',
      additionalProperties: false,
      required: ['node_id', 'x', 'y'],
      properties: { node_id: idSchema(LIMITS.node_id_length), x: coordinateSchema(), y: coordinateSchema() },
    }),
    commandEnvelopeSchema('set_note', {
      type: 'object',
      additionalProperties: false,
      required: ['annotation_id', 'target_ref', 'text', 'position'],
      properties: {
        annotation_id: idSchema(LIMITS.overlay_id_length),
        target_ref: nullableIdSchema(LIMITS.overlay_id_length),
        text: textSchema(LIMITS.description),
        position: positionSchema(),
      },
    }),
    commandEnvelopeSchema('add_annotation_node', {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'label', 'description', 'position'],
      properties: {
        id: idSchema(LIMITS.overlay_id_length),
        label: textSchema(LIMITS.label),
        description: nullableTextSchema(LIMITS.description),
        position: positionSchema(),
      },
    }),
    commandEnvelopeSchema('set_annotation_node', {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'label', 'description'],
      properties: {
        id: idSchema(LIMITS.overlay_id_length),
        label: textSchema(LIMITS.label),
        description: nullableTextSchema(LIMITS.description),
      },
    }),
    commandEnvelopeSchema('add_annotation_edge', {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'from', 'to', 'label', 'description'],
      properties: {
        id: idSchema(LIMITS.overlay_id_length),
        from: idSchema(LIMITS.overlay_id_length),
        to: idSchema(LIMITS.overlay_id_length),
        label: textSchema(LIMITS.label),
        description: nullableTextSchema(LIMITS.description),
      },
    }),
    commandEnvelopeSchema('remove_annotation', {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: { id: idSchema(LIMITS.overlay_id_length) },
    }),
    commandEnvelopeSchema('remove_annotation_node', {
      type: 'object',
      additionalProperties: false,
      required: ['node_id'],
      properties: { node_id: idSchema(LIMITS.overlay_id_length) },
    }),
    commandEnvelopeSchema('set_visibility', {
      type: 'object',
      additionalProperties: false,
      required: ['target_ref', 'hidden'],
      properties: { target_ref: idSchema(LIMITS.overlay_id_length), hidden: { type: 'boolean' } },
    }),
    commandEnvelopeSchema('undo', emptyPayload),
    commandEnvelopeSchema('redo', emptyPayload),
  ];
  return { oneOf: variants };
}

/* ------------------------------------------------------------------------- *
 * Authoritative schema registry
 * ------------------------------------------------------------------------- */

const SCHEMAS = Object.freeze({
  source_identity: withSchemaUri(sourceIdentitySchema()),
  evidence_ref: withSchemaUri(evidenceRefSchema()),
  diagram_spec: withSchemaUri(diagramSpecSchema()),
  annotation_overlay: withSchemaUri(annotationOverlaySchema()),
  artifact_manifest: withSchemaUri(artifactManifestSchema()),
  document_version: withSchemaUri(documentVersionSchema()),
  access_registry: withSchemaUri(accessRegistrySchema()),
  editor_model: withSchemaUri(editorModelSchema()),
  rpc_request: withSchemaUri(rpcRequestSchema()),
  rpc_response: withSchemaUri(rpcResponseSchema()),
});

/**
 * Schemas that are authoritative artifacts but were not listed in the §1
 * `SCHEMAS` export; consumed by src/source-lock.mjs and src/editor/model.mjs.
 */
const ADDITIONAL_SCHEMAS = Object.freeze({
  source_lock: withSchemaUri(sourceLockSchema()),
  editor_command: withSchemaUri(editorCommandSchema()),
});

const ALL_SCHEMAS = Object.freeze({ ...SCHEMAS, ...ADDITIONAL_SCHEMAS });

/** Logical schema name -> authoritative JSON artifact path (relative to project root). */
const SCHEMA_FILES = Object.freeze({
  source_identity: 'schemas/source-identity.schema.json',
  evidence_ref: 'schemas/evidence-ref.schema.json',
  diagram_spec: 'schemas/diagram-spec.schema.json',
  annotation_overlay: 'schemas/annotation-overlay.schema.json',
  artifact_manifest: 'schemas/artifact-manifest.schema.json',
  document_version: 'schemas/document-version.schema.json',
  access_registry: 'schemas/access-registry.schema.json',
  editor_model: 'schemas/editor-model.schema.json',
  rpc_request: 'schemas/rpc-request.schema.json',
  rpc_response: 'schemas/rpc-response.schema.json',
  source_lock: 'schemas/source-lock.schema.json',
  editor_command: 'schemas/editor-command.schema.json',
});

/* ------------------------------------------------------------------------- *
 * Validation helpers
 * ------------------------------------------------------------------------- */

/**
 * @typedef {{ path: string, keyword: string, message: string }} ContractIssue
 */

/**
 * @param {object} schema
 * @param {unknown} value
 * @param {(value:any) => ContractIssue[]} [semantic]
 * @returns {{ok:true, value:any} | {ok:false, errors: ContractIssue[]}}
 */
function validateAgainst(schema, value, semantic) {
  const issues = validateSchema(schema, value);
  if (issues.length > 0) return { ok: false, errors: issues };
  const semanticIssues = semantic ? semantic(value) : [];
  if (semanticIssues.length > 0) return { ok: false, errors: semanticIssues };
  return { ok: true, value };
}

/**
 * @param {string} path
 * @param {string} keyword
 * @param {string} message
 * @returns {ContractIssue}
 */
function issue(path, keyword, message) {
  return { path, keyword, message };
}

/**
 * Record an id in a Map or Set and report a duplicate. Accepts both because
 * call sites use Maps (when the value is needed later) and Sets (membership only).
 * @param {Map<string, any> | Set<string>} seen
 * @param {string} key
 * @param {string} path
 * @returns {ContractIssue[]}
 */
function recordDuplicate(seen, key, path) {
  const issues = [];
  if (seen.has(key)) {
    issues.push(issue(path, 'duplicate_id', `duplicate id ${JSON.stringify(key)}`));
  } else if (typeof seen.add === 'function') {
    seen.add(key);
  } else {
    seen.set(key, 1);
  }
  return issues;
}

/**
 * Semantic invariants of a standalone DiagramSpecV1 (docs/software-design §4,
 * DIA-01). This never re-checks JSON-Schema keywords.
 * @param {any} spec
 * @returns {ContractIssue[]}
 */
function specSemantics(spec) {
  /** @type {ContractIssue[]} */
  const errors = [];
  /** @type {Map<string, any>} */
  const sourcesById = new Map();
  const sourceIds = new Set();
  spec.sources.forEach((/** @type {any} */ source, /** @type {number} */ index) => {
    errors.push(...recordDuplicate(sourceIds, source.source_id, `$.sources[${index}].source_id`));
    if (!sourcesById.has(source.source_id)) sourcesById.set(source.source_id, source);
    const repoIds = new Set();
    source.repos.forEach((/** @type {any} */ repo, /** @type {number} */ repoIndex) => {
      errors.push(...recordDuplicate(repoIds, repo.repo_id, `$.sources[${index}].repos[${repoIndex}].repo_id`));
    });
  });

  const nodeIndexById = new Map();
  spec.nodes.forEach((/** @type {any} */ node, /** @type {number} */ index) => {
    errors.push(...recordDuplicate(nodeIndexById, node.id, `$.nodes[${index}].id`));
  });
  const entityIds = new Set(nodeIndexById.keys());
  spec.edges.forEach((/** @type {any} */ edge, /** @type {number} */ index) => {
    if (entityIds.has(edge.id)) {
      errors.push(issue(`$.edges[${index}].id`, 'duplicate_id', `duplicate document entity id ${JSON.stringify(edge.id)}`));
    } else {
      entityIds.add(edge.id);
    }
    if (!nodeIndexById.has(edge.from)) {
      errors.push(issue(`$.edges[${index}].from`, 'unknown_ref', `edge source ${JSON.stringify(edge.from)} is not a node`));
    }
    if (!nodeIndexById.has(edge.to)) {
      errors.push(issue(`$.edges[${index}].to`, 'unknown_ref', `edge target ${JSON.stringify(edge.to)} is not a node`));
    }
  });

  /**
   * @param {any[]} refs
   * @param {string} path
   */
  const checkEvidenceRefs = (refs, path) => {
    refs.forEach((/** @type {any} */ ref, /** @type {number} */ index) => {
      const refPath = `${path}[${index}]`;
      if (ref.line_end < ref.line_start) {
        errors.push(issue(refPath, 'invalid_range', 'line_end must not be smaller than line_start'));
      }
      const source = sourcesById.get(ref.source_id);
      if (!source) {
        errors.push(issue(`${refPath}.source_id`, 'unknown_ref', `evidence source ${JSON.stringify(ref.source_id)} is not declared in sources`));
        return;
      }
      if (!source.repos.some((/** @type {any} */ repo) => repo.repo_id === ref.repo_id)) {
        errors.push(issue(`${refPath}.repo_id`, 'unknown_ref', `evidence repo ${JSON.stringify(ref.repo_id)} is not declared for its source`));
      }
    });
  };

  spec.nodes.forEach((/** @type {any} */ node, /** @type {number} */ index) => {
    checkEvidenceRefs(node.evidence_refs, `$.nodes[${index}].evidence_refs`);
    if (node.origin === 'annotation' && node.evidence_refs.length > 0) {
      errors.push(issue(`$.nodes[${index}].evidence_refs`, 'annotation_has_evidence', 'annotation nodes must not carry evidence_refs'));
    }
  });

  spec.edges.forEach((/** @type {any} */ edge, /** @type {number} */ index) => {
    checkEvidenceRefs(edge.evidence_refs, `$.edges[${index}].evidence_refs`);
    if (spec.mode === 'conceptual') {
      if (edge.origin !== 'annotation') {
        errors.push(issue(`$.edges[${index}].origin`, 'conceptual_invariant', 'conceptual edges must have origin=annotation'));
      }
      if (edge.certainty !== 'unknown') {
        errors.push(issue(`$.edges[${index}].certainty`, 'conceptual_invariant', 'conceptual edges must have certainty=unknown'));
      }
      if (edge.evidence_refs.length > 0) {
        errors.push(issue(`$.edges[${index}].evidence_refs`, 'conceptual_invariant', 'conceptual edges must not carry evidence_refs'));
      }
      return;
    }
    if (edge.origin === 'evidence') {
      if (edge.kind === 'annotation') {
        errors.push(issue(`$.edges[${index}].kind`, 'inconsistent_edge', 'evidence origin cannot use kind=annotation'));
      }
      if (edge.certainty === 'unknown') {
        errors.push(issue(`$.edges[${index}].certainty`, 'inconsistent_edge', 'evidence origin cannot use certainty=unknown'));
      }
      if (edge.certainty === 'exact' && edge.evidence_refs.length === 0) {
        errors.push(issue(`$.edges[${index}].evidence_refs`, 'exact_requires_evidence', 'exact evidence edges require evidence_refs'));
      }
    } else {
      if (edge.certainty !== 'unknown') {
        errors.push(issue(`$.edges[${index}].certainty`, 'annotation_invariant', 'annotation edges must have certainty=unknown'));
      }
      if (edge.evidence_refs.length > 0) {
        errors.push(issue(`$.edges[${index}].evidence_refs`, 'annotation_has_evidence', 'annotation edges must not carry evidence_refs'));
      }
      if (edge.kind !== 'annotation') {
        errors.push(issue(`$.edges[${index}].kind`, 'annotation_invariant', 'annotation edges must use kind=annotation in evidence mode'));
      }
    }
  });

  if (spec.mode === 'conceptual') {
    if (spec.sources.length > 0) {
      errors.push(issue('$.sources', 'conceptual_invariant', 'conceptual mode must have empty sources'));
    }
    spec.nodes.forEach((/** @type {any} */ node, /** @type {number} */ index) => {
      if (node.origin !== 'annotation') {
        errors.push(issue(`$.nodes[${index}].origin`, 'conceptual_invariant', 'conceptual nodes must have origin=annotation'));
      }
    });
  } else if (spec.sources.length === 0) {
    errors.push(issue('$.sources', 'evidence_sources_required', 'evidence mode requires at least one source identity'));
  }

  const positionNodeIds = new Set();
  spec.layout.positions.forEach((/** @type {any} */ position, /** @type {number} */ index) => {
    if (!nodeIndexById.has(position.node_id)) {
      errors.push(issue(`$.layout.positions[${index}].node_id`, 'unknown_ref', 'layout position must target a node'));
    }
    errors.push(...recordDuplicate(positionNodeIds, position.node_id, `$.layout.positions[${index}].node_id`));
  });

  return errors;
}

/**
 * Semantic invariants checkable without a base spec (overlay-local).
 * @param {any} overlay
 * @returns {ContractIssue[]}
 */
function overlaySemantics(overlay) {
  /** @type {ContractIssue[]} */
  const errors = [];
  const itemIds = new Set();
  const layoutTargets = new Set();
  const visibilityTargets = new Set();
  overlay.items.forEach((/** @type {any} */ item, /** @type {number} */ index) => {
    errors.push(...recordDuplicate(itemIds, item.id, `$.items[${index}].id`));
    if (item.kind === 'note' || item.kind === 'annotation_node' || item.kind === 'annotation_edge') {
      if (!item.id.startsWith('ann:')) {
        errors.push(issue(`$.items[${index}].id`, 'id_prefix', 'new annotation items must use the ann: prefix'));
      }
    }
    if (item.kind === 'layout') {
      errors.push(...recordDuplicate(layoutTargets, item.target_ref, `$.items[${index}].target_ref`));
    }
    if (item.kind === 'visibility') {
      errors.push(...recordDuplicate(visibilityTargets, item.target_ref, `$.items[${index}].target_ref`));
    }
  });
  return errors;
}

/* ------------------------------------------------------------------------- *
 * Public validators (docs/interfaces.md §1)
 * ------------------------------------------------------------------------- */

/** @param {unknown} value */
function validateSourceIdentity(value) {
  return validateAgainst(SCHEMAS.source_identity, value);
}

/** @param {unknown} value */
function validateEvidenceRef(value) {
  return validateAgainst(SCHEMAS.evidence_ref, value);
}

/** @param {unknown} value */
function validateDiagramSpec(value) {
  return validateAgainst(SCHEMAS.diagram_spec, value, specSemantics);
}

/** @param {unknown} value */
function validateOverlay(value) {
  return validateAgainst(SCHEMAS.annotation_overlay, value, overlaySemantics);
}

/** @param {unknown} value */
function validateManifest(value) {
  return validateAgainst(SCHEMAS.artifact_manifest, value);
}

/** @param {unknown} value */
function validateDocumentVersion(value) {
  return validateAgainst(SCHEMAS.document_version, value);
}

/** @param {unknown} value */
function validateAccessRegistry(value) {
  return validateAgainst(SCHEMAS.access_registry, value);
}

/** @param {unknown} value */
function validateEditorModel(value) {
  return validateAgainst(SCHEMAS.editor_model, value);
}

/** @param {unknown} value */
function validateRpcRequest(value) {
  return validateAgainst(SCHEMAS.rpc_request, value);
}

/** @param {unknown} value */
function validateRpcResponse(value) {
  return validateAgainst(SCHEMAS.rpc_response, value);
}

/** @param {unknown} value */
function validateSourceLock(value) {
  return validateAgainst(ALL_SCHEMAS.source_lock, value);
}

/** @param {unknown} value */
function validateEditorCommand(value) {
  return validateAgainst(ALL_SCHEMAS.editor_command, value);
}

/**
 * Cross-object invariants for base spec + annotation overlay (DIA-OVERLAY-01).
 *
 * @param {unknown} spec
 * @param {unknown} overlay
 * @returns {{ok:true, value:{spec:any, overlay:any}} | {ok:false, errors: ContractIssue[]}}
 */
function validateComposite(spec, overlay) {
  const specResult = validateDiagramSpec(spec);
  if (!specResult.ok) return { ok: false, errors: specResult.errors };
  const overlayResult = validateOverlay(overlay);
  if (!overlayResult.ok) {
    return { ok: false, errors: overlayResult.errors.map((entry) => ({ ...entry, path: `$.overlay${entry.path.slice(1)}` })) };
  }
  const specValue = specResult.value;
  const overlayValue = overlayResult.value;
  /** @type {ContractIssue[]} */
  const errors = [];

  if (overlayValue.diagram_id !== specValue.diagram_id) {
    errors.push(issue('$.overlay.diagram_id', 'diagram_mismatch', 'overlay diagram_id must match the base spec'));
  }
  if (overlayValue.base_spec_digest !== specDigest(specValue)) {
    errors.push(issue('$.overlay.base_spec_digest', 'base_digest_mismatch', 'overlay base_spec_digest must equal specDigest(spec)'));
  }

  const baseNodeIds = new Set(specValue.nodes.map((/** @type {any} */ node) => node.id));
  const baseEntityIds = new Set([...baseNodeIds, ...specValue.edges.map((/** @type {any} */ edge) => edge.id)]);
  const annotationNodeIds = new Set();
  const annotationEdgeIds = new Set();
  const hiddenTargets = new Set();
  for (const item of overlayValue.items) {
    if (item.kind === 'annotation_node') annotationNodeIds.add(item.id);
    if (item.kind === 'annotation_edge') annotationEdgeIds.add(item.id);
    if (item.kind === 'visibility' && item.hidden === true) hiddenTargets.add(item.target_ref);
  }
  const visibleNodeIds = new Set();
  for (const nodeId of baseNodeIds) if (!hiddenTargets.has(nodeId)) visibleNodeIds.add(nodeId);
  for (const nodeId of annotationNodeIds) visibleNodeIds.add(nodeId);
  const documentEntityIds = new Set([...baseEntityIds, ...annotationNodeIds, ...annotationEdgeIds]);

  overlayValue.items.forEach((/** @type {any} */ item, /** @type {number} */ index) => {
    const itemPath = `$.overlay.items[${index}]`;
    if (baseEntityIds.has(item.id)) {
      errors.push(issue(`${itemPath}.id`, 'duplicate_id', 'overlay item id collides with a base node/edge id'));
    }
    if (item.kind === 'annotation_node' && specValue.mode === 'evidence') {
      errors.push(issue(`${itemPath}.kind`, 'forbidden_item', 'evidence diagrams must not add annotation_node items'));
    }
    if (item.kind === 'layout') {
      if (!baseNodeIds.has(item.target_ref)) {
        errors.push(issue(`${itemPath}.target_ref`, 'unknown_ref', 'layout must target a base node'));
      }
    } else if (item.kind === 'visibility') {
      if (!baseEntityIds.has(item.target_ref)) {
        errors.push(issue(`${itemPath}.target_ref`, 'unknown_ref', 'visibility must target a base node or edge'));
      }
    } else if (item.kind === 'note') {
      if (item.target_ref !== null && !documentEntityIds.has(item.target_ref)) {
        errors.push(issue(`${itemPath}.target_ref`, 'unknown_ref', 'note target must be an existing document entity'));
      }
    } else if (item.kind === 'annotation_edge') {
      for (const endpoint of ['from', 'to']) {
        const nodeId = item[endpoint];
        if (!visibleNodeIds.has(nodeId)) {
          const keyword = documentEntityIds.has(nodeId) ? 'not_visible' : 'unknown_ref';
          errors.push(issue(`${itemPath}.${endpoint}`, keyword, `annotation edge endpoint ${JSON.stringify(nodeId)} must be a visible node`));
        }
      }
    }
  });

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { spec: specValue, overlay: overlayValue } };
}

/* ------------------------------------------------------------------------- *
 * Digests
 *
 * Runtime-only metadata is excluded from the *document* digests so an
 * identical diagram regenerated later keeps a stable overlay binding:
 * - specDigest ignores generated_at and source_state (identity cache);
 * - overlayDigest ignores updated_at.
 * Manifest and document-version digests bind the full stored bytes.
 * ------------------------------------------------------------------------- */

/**
 * @param {unknown} spec
 * @returns {string} sha256 hex over the canonical base spec
 */
function specDigest(spec) {
  const result = validateDiagramSpec(spec);
  if (!result.ok) fail(CODES.INVALID_SPEC, 'cannot digest an invalid diagram spec', { errors: result.errors });
  const base = { ...result.value };
  delete base.generated_at;
  delete base.source_state;
  return sha256Hex(canonicalJson(base));
}

/**
 * @param {unknown} overlay
 * @returns {string}
 */
function overlayDigest(overlay) {
  const result = validateOverlay(overlay);
  if (!result.ok) fail(CODES.INVALID_OVERLAY, 'cannot digest an invalid annotation overlay', { errors: result.errors });
  const base = { ...result.value };
  delete base.updated_at;
  return sha256Hex(canonicalJson(base));
}

/**
 * @param {unknown} manifest
 * @returns {string}
 */
function manifestDigest(manifest) {
  const result = validateManifest(manifest);
  if (!result.ok) fail(CODES.INVALID_MANIFEST, 'cannot digest an invalid artifact manifest', { errors: result.errors });
  return sha256Hex(canonicalJson(result.value));
}

/**
 * @param {unknown} version
 * @returns {string}
 */
function documentVersionDigest(version) {
  const result = validateDocumentVersion(version);
  if (!result.ok) fail(CODES.INVALID_INPUT, 'cannot digest an invalid document version', { errors: result.errors });
  return sha256Hex(canonicalJson(result.value));
}

/* ------------------------------------------------------------------------- *
 * Constructors and string helpers
 * ------------------------------------------------------------------------- */

/**
 * @param {unknown} value
 * @param {number} maxLength
 * @param {string} name
 * @returns {string}
 */
function text(value, maxLength = LIMITS.label, name = 'text') {
  if (typeof value !== 'string') fail(CODES.INVALID_INPUT, `${name} must be a string`);
  if (!Number.isSafeInteger(maxLength) || maxLength < 0) fail(CODES.INVALID_INPUT, `${name} maxLength must be a non-negative integer`);
  const length = [...value].length;
  if (length > maxLength) fail(CODES.INVALID_INPUT, `${name} must be at most ${maxLength} characters`);
  if (CONTROL_CHARS_REGEX.test(value)) fail(CODES.INVALID_INPUT, `${name} contains forbidden control characters`);
  return value;
}

/**
 * @param {unknown} value
 * @param {number} maxLength
 * @param {string} name
 * @returns {string}
 */
function id(value, maxLength = ID_MAX, name = 'id') {
  if (typeof value !== 'string') fail(CODES.INVALID_INPUT, `${name} must be a string`);
  if (!Number.isSafeInteger(maxLength) || maxLength < 1) fail(CODES.INVALID_INPUT, `${name} maxLength must be a positive integer`);
  const length = [...value].length;
  if (length < 1 || length > maxLength) fail(CODES.INVALID_INPUT, `${name} must be 1..${maxLength} characters`);
  if (!ID_REGEX.test(value)) fail(CODES.INVALID_INPUT, `${name} contains characters that are not allowed in a document id`);
  return value;
}

/**
 * @param {unknown} value
 * @param {string} [name]
 * @returns {string}
 */
function utcTimestamp(value, name = 'timestamp') {
  if (typeof value !== 'string' || !TIMESTAMP_REGEX.test(value)) {
    fail(CODES.INVALID_INPUT, `${name} must be a UTC ISO timestamp (YYYY-MM-DDTHH:mm:ss.sssZ)`);
  }
  return /** @type {string} */ (value);
}

/**
 * @param {unknown} value
 * @param {string} [name]
 * @returns {string}
 */
function sha256HexValue(value, name = 'digest') {
  if (typeof value !== 'string' || !SHA256_HEX_REGEX.test(value)) {
    fail(CODES.INVALID_INPUT, `${name} must be a lowercase sha256 hex digest`);
  }
  return /** @type {string} */ (value);
}

/**
 * @param {unknown} value
 * @param {string} [name]
 * @returns {string}
 */
function rendererRefValue(value, name = 'renderer_ref') {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128 || CONTROL_CHARS_REGEX.test(value)) {
    fail(CODES.INVALID_INPUT, `${name} must be a non-empty plain string of at most 128 characters`);
  }
  if (!RENDERER_REF_REGEX.test(value)) {
    fail(CODES.INVALID_INPUT, `${name} must look like "family:variant"`);
  }
  return /** @type {string} */ (value);
}

/**
 * Build an empty annotation overlay bound to a base spec digest
 * (docs/interfaces.md §1).
 *
 * @param {{diagram_id: string, base_spec_digest: string, now?: string | (() => string)}} options
 * @returns {any}
 */
function emptyOverlay(options) {
  if (options === null || typeof options !== 'object') {
    fail(CODES.INVALID_INPUT, 'emptyOverlay requires {diagram_id, base_spec_digest, now}');
  }
  const diagramId = id(options.diagram_id, ID_MAX, 'diagram_id');
  const baseSpecDigest = sha256HexValue(options.base_spec_digest, 'base_spec_digest');
  let now;
  if (typeof options.now === 'function') {
    now = options.now();
  } else if (options.now === undefined || options.now === null) {
    now = new Date().toISOString();
  } else {
    now = options.now;
  }
  const overlay = {
    schema_version: 1,
    diagram_id: diagramId,
    base_spec_digest: baseSpecDigest,
    revision: 0,
    items: [],
    orphaned_annotations: [],
    updated_at: utcTimestamp(now, 'now'),
  };
  const result = validateOverlay(overlay);
  if (!result.ok) fail(CODES.INVALID_OVERLAY, 'constructed overlay failed validation', { errors: result.errors });
  return overlay;
}

/** Media type and relative path regexes are exported for renderer tests. */
const PATTERNS_EXTRA = Object.freeze({
  media_type: MEDIA_TYPE_REGEX.source,
  relative_path: RELATIVE_PATH_REGEX.source,
  renderer_ref: RENDERER_REF_REGEX.source,
});

/** Editor command union kinds, in schema order. */
const EDITOR_COMMAND_KIND_LIST = EDITOR_COMMAND_KINDS;

exports.PATTERNS = PATTERNS;
exports.SCHEMAS = SCHEMAS;
exports.ADDITIONAL_SCHEMAS = ADDITIONAL_SCHEMAS;
exports.ALL_SCHEMAS = ALL_SCHEMAS;
exports.SCHEMA_FILES = SCHEMA_FILES;
exports.validateSourceIdentity = validateSourceIdentity;
exports.validateEvidenceRef = validateEvidenceRef;
exports.validateDiagramSpec = validateDiagramSpec;
exports.validateOverlay = validateOverlay;
exports.validateManifest = validateManifest;
exports.validateDocumentVersion = validateDocumentVersion;
exports.validateAccessRegistry = validateAccessRegistry;
exports.validateEditorModel = validateEditorModel;
exports.validateRpcRequest = validateRpcRequest;
exports.validateRpcResponse = validateRpcResponse;
exports.validateSourceLock = validateSourceLock;
exports.validateEditorCommand = validateEditorCommand;
exports.validateComposite = validateComposite;
exports.specDigest = specDigest;
exports.overlayDigest = overlayDigest;
exports.manifestDigest = manifestDigest;
exports.documentVersionDigest = documentVersionDigest;
exports.text = text;
exports.id = id;
exports.utcTimestamp = utcTimestamp;
exports.sha256HexValue = sha256HexValue;
exports.rendererRefValue = rendererRefValue;
exports.emptyOverlay = emptyOverlay;
exports.PATTERNS_EXTRA = PATTERNS_EXTRA;
exports.EDITOR_COMMAND_KIND_LIST = EDITOR_COMMAND_KIND_LIST;
		};
		__definitions["src/descriptor.mjs"] = function (module, exports, __require) {
/**
 * 08 workbench navigation descriptor + client adapter contract for 06.
 *
 * DIA-10 / DIA-DESIGN-2 §9.1: the 08 entry point only produces a navigation
 * intent. It never holds XML, a base spec, an overlay, a version token or a
 * filesystem path, and it never saves on 06's behalf. The 08 *client* adapter is
 * the only party that calls `ctx.layout.selectPanel('local-diagrams')`; the
 * actual open request is delivered to the 06 main panel through a local
 * in-page event whose payload is a set of registry references, and the 06 Host
 * RPC channel re-validates every reference against the trusted access registry.
 *
 * This module is pure and has no DOM/Node globals at import time; the browser
 * panel re-uses `OPEN_EVENT` (inlined by tools/build-client.mjs) so producer and
 * consumer cannot drift.
 */

const { PATTERNS } = __require("src/contracts.mjs");

/** Capability number owned by this package. */
const CAPABILITY = '06';
/** Navigation intent id (stable; part of the 08 adapter contract). */
const INTENT = 'open-diagram';
/** Main keyed-slot panel id registered by the client bundle. */
const PANEL_ID = 'local-diagrams';
/** Authenticated Host RPC channel. */
const CHANNEL = '/local-diagrams';
/** In-page event that carries an open request from a navigation adapter. */
const OPEN_EVENT = 'dsh-local-diagrams:open';
/** Event schema marker; unknown versions are ignored by the panel. */
const OPEN_EVENT_VERSION = 1;

/** Same ref pattern as the RPC contract (`PATTERNS.id`). */
const REF_PATTERN = new RegExp(PATTERNS.id, 'u');

/** Fields a navigation intent may never carry (data/elevation surface). */
const FORBIDDEN_INTENT_FIELDS = Object.freeze([
  'xml',
  'drawio',
  'base_spec',
  'overlay',
  'annotations',
  'version',
  'expected_version',
  'path',
  'path_ref',
  'url',
  'data',
  'caller',
  'grant',
  'scope_ref',
  'document_id',
]);

/**
 * The descriptor 08 consumes. Frozen, tiny, no document state.
 * @returns {{schema_version:1, capability:string, intent:string, panel:string, channel:string}}
 */
function navigationDescriptor() {
  return Object.freeze({
    schema_version: 1,
    capability: CAPABILITY,
    intent: INTENT,
    panel: PANEL_ID,
    channel: CHANNEL,
  });
}

/** Frozen singleton of {@link navigationDescriptor}. */
const NAVIGATION_DESCRIPTOR = navigationDescriptor();

/**
 * The client-side adapter contract: what 08's client half is allowed to do.
 * It receives an intent, validates it, selects the 06 main panel, and publishes
 * the references through {@link OPEN_EVENT}. It is not allowed to open documents
 * itself, hold editor state, or pass data through.
 */
const CLIENT_ADAPTER_CONTRACT = Object.freeze({
  schema_version: 1,
  capability: CAPABILITY,
  intent: INTENT,
  panel: PANEL_ID,
  open_event: OPEN_EVENT,
  open_event_version: OPEN_EVENT_VERSION,
  steps: Object.freeze([
    'validateIntent',
    'selectPanel(local-diagrams)',
    'publishOpenEvent({document_ref, context_ref, expected_scope_generation})',
  ]),
  allowed_intent_fields: Object.freeze(['document_ref', 'context_ref', 'expected_scope_generation']),
  forbidden_intent_fields: FORBIDDEN_INTENT_FIELDS,
  holds_document_state: false,
  calls_host_save: false,
});

/** @param {unknown} value @returns {boolean} */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** @param {unknown} value @returns {boolean} */
function isRef(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= 128 && REF_PATTERN.test(value);
}

/**
 * @param {string} path
 * @param {string} message
 * @returns {{path:string, keyword:string, message:string}}
 */
function issue(path, message) {
  return { path, keyword: 'invalid_navigation_intent', message };
}

/**
 * Validate a navigation intent or the raw `{document_ref, context_ref,
 * expected_scope_generation}` input. Closed object: no extra fields, explicit
 * denial of data/elevation fields, registry references only (never a path).
 *
 * @param {unknown} value
 * @returns {{ok:true, intent:{document_ref:string, context_ref:string, expected_scope_generation:number}} | {ok:false, errors:Array<{path:string,keyword:string,message:string}>}}
 */
function validateOpenIntent(value) {
  /** @type {Array<{path:string,keyword:string,message:string}>} */
  const errors = [];
  if (!isRecord(value)) {
    errors.push(issue('$', 'intent must be an object'));
    return { ok: false, errors };
  }
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_INTENT_FIELDS.includes(key)) {
      errors.push(issue(`$.${key}`, `navigation intents must not carry "${key}"; 08 holds no document state`));
    }
  }
  const allowed = ['document_ref', 'context_ref', 'expected_scope_generation'];
  for (const key of allowed) {
    if (!Object.hasOwn(value, key)) errors.push(issue(`$.${key}`, `missing ${key}`));
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) errors.push(issue(`$.${key}`, `unexpected field "${key}"`));
  }
  if (Object.hasOwn(value, 'document_ref') && !isRef(value.document_ref)) {
    errors.push(issue('$.document_ref', 'document_ref must be a registry reference (1-128 id chars), not a path'));
  }
  if (Object.hasOwn(value, 'context_ref') && !isRef(value.context_ref)) {
    errors.push(issue('$.context_ref', 'context_ref must be a registered context reference'));
  }
  if (
    Object.hasOwn(value, 'expected_scope_generation') &&
    (typeof value.expected_scope_generation !== 'number' ||
      !Number.isSafeInteger(value.expected_scope_generation) ||
      value.expected_scope_generation < 0)
  ) {
    errors.push(issue('$.expected_scope_generation', 'expected_scope_generation must be a non-negative safe integer'));
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    intent: {
      document_ref: value.document_ref,
      context_ref: value.context_ref,
      expected_scope_generation: value.expected_scope_generation,
    },
  };
}

/**
 * Build a validated open intent for 08 to hand to the client adapter.
 * @param {{document_ref:string, context_ref:string, expected_scope_generation:number}} input
 * @returns {ReturnType<typeof validateOpenIntent>}
 */
function createOpenIntent(input) {
  return validateOpenIntent(input);
}

/**
 * The open-event payload the 06 panel consumes. Kept separate from the intent
 * so a producer can never inject `view_epoch` or command payloads.
 *
 * @param {{document_ref:string, context_ref:string, expected_scope_generation:number}} input
 * @returns {{ok:true, type:string, version:1, detail:{document_ref:string, context_ref:string, expected_scope_generation:number}} | {ok:false, errors:any[]}}
 */
function createOpenEventDetail(input) {
  const validated = validateOpenIntent(input);
  if (validated.ok !== true) return { ok: false, errors: validated.errors };
  return {
    ok: true,
    type: OPEN_EVENT,
    version: OPEN_EVENT_VERSION,
    detail: {
      document_ref: validated.intent.document_ref,
      context_ref: validated.intent.context_ref,
      expected_scope_generation: validated.intent.expected_scope_generation,
    },
  };
}

/**
 * Apply one navigation intent through a 08 client adapter. The adapter object
 * is injected (never global) so this function is Node-testable and the caller
 * cannot smuggle extra capabilities.
 *
 * @param {{selectPanel:(panelId:string)=>void, publishOpen:(detail:any)=>void}} adapter
 * @param {unknown} intent
 * @returns {{ok:true, panel:string, published:any} | {ok:false, errors:Array<{path:string,keyword:string,message:string}>}}
 */
function applyNavigationIntent(adapter, intent) {
  if (!isRecord(adapter) || typeof adapter.selectPanel !== 'function' || typeof adapter.publishOpen !== 'function') {
    return {
      ok: false,
      errors: [issue('$.adapter', 'adapter needs selectPanel(panelId) and publishOpen(detail) functions')],
    };
  }
  const validated = validateOpenIntent(intent);
  if (validated.ok !== true) return { ok: false, errors: validated.errors };
  const detail = {
    document_ref: validated.intent.document_ref,
    context_ref: validated.intent.context_ref,
    expected_scope_generation: validated.intent.expected_scope_generation,
  };
  adapter.selectPanel(PANEL_ID);
  adapter.publishOpen(detail);
  return { ok: true, panel: PANEL_ID, published: detail };
}

/**
 * Validate an event detail received by the 06 panel. Unknown/unsafe payloads
 * are rejected; the panel then asks the Host, which re-checks the registry.
 * @param {unknown} detail
 * @returns {ReturnType<typeof validateOpenIntent>}
 */
function validateOpenEventDetail(detail) {
  return validateOpenIntent(detail);
}

exports.CAPABILITY = CAPABILITY;
exports.INTENT = INTENT;
exports.PANEL_ID = PANEL_ID;
exports.CHANNEL = CHANNEL;
exports.OPEN_EVENT = OPEN_EVENT;
exports.OPEN_EVENT_VERSION = OPEN_EVENT_VERSION;
exports.FORBIDDEN_INTENT_FIELDS = FORBIDDEN_INTENT_FIELDS;
exports.navigationDescriptor = navigationDescriptor;
exports.NAVIGATION_DESCRIPTOR = NAVIGATION_DESCRIPTOR;
exports.CLIENT_ADAPTER_CONTRACT = CLIENT_ADAPTER_CONTRACT;
exports.validateOpenIntent = validateOpenIntent;
exports.createOpenIntent = createOpenIntent;
exports.createOpenEventDetail = createOpenEventDetail;
exports.applyNavigationIntent = applyNavigationIntent;
exports.validateOpenEventDetail = validateOpenEventDetail;
		};
		__definitions["src/drawio/xml.mjs"] = function (module, exports, __require) {
/**
 * Restricted XML parsing + mxGraphModel serialization (DIA-06 / DIA-API-RENDER).
 *
 * This module is deliberately NOT a general XML parser. It implements the
 * frozen subset from DIA-DESIGN-2 §7 and docs/interfaces.md §6:
 *
 *  - input must be valid UTF-8 (bytes are decoded strictly; JS strings are
 *    rejected when they contain lone surrogates or non-XML code points);
 *  - only elements, attributes and character data are accepted: no DOCTYPE,
 *    internal/external entities, CDATA, processing instructions (including the
 *    XML declaration), comments or namespace declarations;
 *  - element/attribute names are ASCII names (no `:`), attributes must be
 *    quoted by ' or ", duplicate attributes are rejected, exactly one root
 *    element is allowed and the element stack must be empty at EOF;
 *  - only the five predefined entities plus decimal/hex numeric character
 *    references that resolve to legal XML code points;
 *  - byte/depth/element/attribute limits are checked while scanning, before
 *    building large structures.
 *
 * On top of that it implements the tool-owned `.drawio` profile:
 * `<mxfile>/<diagram>/<mxGraphModel>/<root>/<mxCell>/<mxGeometry>/<mxPoint>/
 * <Array>` with a strict attribute whitelist, a closed style whitelist and the
 * `data_*` display-only metadata attributes. Compressed diagram payloads,
 * unknown advanced shapes and unknown style keys are reported as UNSUPPORTED,
 * never silently stripped and re-saved.
 *
 * Everything here is synchronous, has no network/file access and is
 * deterministic: identical input produces byte-identical output.
 */

const { LIMITS } = __require("src/limits.mjs");
const { DiagramError } = __require("src/errors.mjs");
const { canonicalJson, utf8Length } = __require("src/canonical.mjs");

/* -------------------------------------------------------------------------- */
/* contracts seam                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The shared contracts module is authored in parallel (owner: contracts).
 * Loading it lazily keeps the restricted tokenizer independently testable and
 * makes semantic entry points fail closed instead of silently skipping schema
 * checks. Only a genuinely missing module is tolerated.
 */
let CONTRACTS = null;
try {
  CONTRACTS = __require("src/contracts.mjs");
} catch (error) {
  if (!(error && /** @type {any} */ (error).code === 'ERR_MODULE_NOT_FOUND')) throw error;
}

/** @returns {any} */
function requireContracts() {
  if (!CONTRACTS) {
    throw new DiagramError('INVALID_INPUT', 'shared contracts module (src/contracts.mjs) is not available');
  }
  return CONTRACTS;
}

/* -------------------------------------------------------------------------- */
/* shared helpers                                                              */
/* -------------------------------------------------------------------------- */

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

/** @param {unknown} value @returns {value is Record<string, any>} */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** @param {string} path @param {string} keyword @param {string} message */
function issue(path, keyword, message) {
  return { path, keyword, message };
}

const RESERVED_NAMES = new Set(['__proto__', 'constructor', 'prototype']);
const NAMED_ENTITIES = new Map([
  ['lt', '<'],
  ['gt', '>'],
  ['amp', '&'],
  ['quot', '"'],
  ['apos', "'"],
]);

/**
 * XML 1.0 Char production (BMP subset + astral planes).
 * @param {number} cp
 * @returns {boolean}
 */
function isLegalXmlCodePoint(cp) {
  if (!Number.isSafeInteger(cp) || cp < 0 || cp > 0x10ffff) return false;
  if (cp === 0x9 || cp === 0xa || cp === 0xd) return true;
  if (cp >= 0x20 && cp <= 0xd7ff) return true;
  if (cp >= 0xe000 && cp <= 0xfffd) return true;
  if (cp >= 0x10000 && cp <= 0x10ffff) return true;
  return false;
}

/** @param {number} code */
function isNameStartCode(code) {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) || code === 0x5f;
}

/** @param {number} code */
function isNameCharCode(code) {
  return isNameStartCode(code) || (code >= 0x30 && code <= 0x39) || code === 0x2e || code === 0x2d;
}

/** @param {number} code */
function isWhitespaceCode(code) {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

/** @param {string} value */
function escXmlAttr(value) {
  return String(value).replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&apos;';
    }
  });
}

/** @param {string} value */
function escXmlText(value) {
  return String(value).replace(/[&<>]/g, (ch) => (ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : '&gt;'));
}

/**
 * HTML/script markup must never be stored as a drawio value. The XML itself
 * escapes everything before it reaches this check; the decoded text is still
 * refused so a file cannot smuggle a tag that a later consumer might execute.
 * @param {string} value
 * @returns {boolean}
 */
function looksLikeMarkup(value) {
  if (typeof value !== 'string') return false;
  const tag =
    /<\s*\/?\s*(?:script|img|svg|foreignobject|iframe|style|object|embed|link|meta|a|div|span|p|br|body|html)\b[^>]*>/i;
  if (tag.test(value)) return true;
  if (/["']\s*on[a-z]+\s*=\s*["']?/i.test(value)) return true;
  return false;
}

/* -------------------------------------------------------------------------- */
/* restricted XML parser                                                       */
/* -------------------------------------------------------------------------- */

const XML_LIMITS = Object.freeze({
  xml_bytes: LIMITS.xml_bytes,
  xml_depth: LIMITS.xml_depth,
  xml_elements: LIMITS.xml_elements,
  xml_attributes_per_element: LIMITS.xml_attributes_per_element,
});

/**
 * @param {Record<string, number> | undefined} custom
 * @returns {{xml_bytes: number, xml_depth: number, xml_elements: number, xml_attributes_per_element: number}}
 */
function resolveXmlLimits(custom) {
  const resolved = { ...XML_LIMITS };
  if (isRecord(custom)) {
    for (const key of Object.keys(resolved)) {
      const value = custom[key];
      if (Number.isSafeInteger(value) && value >= 1) resolved[key] = value;
    }
  }
  return resolved;
}

/**
 * Strictly decode the caller's input. Buffers/typed arrays must be valid
 * UTF-8; strings must not contain lone surrogates or non-XML code points.
 * @param {unknown} input
 * @returns {{ok: true, text: string, bytes: number} | {ok: false, keyword: 'invalidUtf8' | 'invalidChar'}}
 */
function decodeInput(input) {
  /** @type {string} */
  let text;
  /** @type {number} */
  let bytes;
  if (typeof input === 'string') {
    text = input;
    bytes = utf8Length(text);
  } else if (input instanceof Uint8Array) {
    bytes = input.byteLength;
    try {
      text = UTF8_DECODER.decode(input);
    } catch {
      return { ok: false, keyword: 'invalidUtf8' };
    }
  } else {
    return { ok: false, keyword: 'invalidUtf8' };
  }
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
    bytes = Math.max(0, bytes - 3);
  }
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return { ok: false, keyword: 'invalidUtf8' };
      const cp = (code - 0xd800) * 0x400 + (next - 0xdc00) + 0x10000;
      if (!isLegalXmlCodePoint(cp)) return { ok: false, keyword: 'invalidChar' };
      i += 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) return { ok: false, keyword: 'invalidUtf8' };
    if (!isLegalXmlCodePoint(code)) return { ok: false, keyword: 'invalidChar' };
  }
  return { ok: true, text, bytes };
}

/**
 * Decode the five predefined entities and legal numeric character references.
 * @param {string} raw
 * @returns {{ok: true, value: string} | {ok: false, keyword: string, message: string}}
 */
function decodeEntities(raw) {
  if (raw.indexOf('&') === -1) return { ok: true, value: raw };
  let out = '';
  let i = 0;
  while (i < raw.length) {
    const amp = raw.indexOf('&', i);
    if (amp === -1) {
      out += raw.slice(i);
      break;
    }
    out += raw.slice(i, amp);
    const semi = raw.indexOf(';', amp + 1);
    if (semi === -1 || semi - amp > 12) {
      return { ok: false, keyword: 'invalidEntity', message: `unterminated entity reference at offset ${amp}` };
    }
    const body = raw.slice(amp + 1, semi);
    if (body.length === 0) {
      return { ok: false, keyword: 'invalidEntity', message: `empty entity reference at offset ${amp}` };
    }
    if (body.charCodeAt(0) === 0x23 /* # */) {
      let cp;
      if (body.length > 1 && (body[1] === 'x' || body[1] === 'X')) {
        if (!/^[0-9A-Fa-f]+$/.test(body.slice(2))) {
          return { ok: false, keyword: 'invalidNumericEntity', message: `invalid hex character reference at offset ${amp}` };
        }
        cp = Number.parseInt(body.slice(2), 16);
      } else {
        if (!/^[0-9]+$/.test(body.slice(1))) {
          return { ok: false, keyword: 'invalidNumericEntity', message: `invalid decimal character reference at offset ${amp}` };
        }
        cp = Number.parseInt(body.slice(1), 10);
      }
      if (!isLegalXmlCodePoint(cp)) {
        return { ok: false, keyword: 'invalidNumericEntity', message: `character reference ${body} is not a legal XML code point` };
      }
      out += String.fromCodePoint(cp);
    } else {
      const mapped = NAMED_ENTITIES.get(body);
      if (mapped === undefined) {
        return { ok: false, keyword: 'unknownEntity', message: `entity &${body}; is not allowed` };
      }
      out += mapped;
    }
    i = semi + 1;
  }
  return { ok: true, value: out };
}

/**
 * @typedef {{name: string, attributes: Record<string, string>, children: Array<any>, text: string}} XmlNode
 */

/**
 * Parse the restricted XML subset.
 *
 * @param {string | Uint8Array} input
 * @param {{limits?: Record<string, number>}} [options]
 * @returns {{ok: true, root: XmlNode} | {ok: false, code: 'INVALID_XML' | 'LIMIT_EXCEEDED', errors: Array<{path: string, keyword: string, message: string}>}}
 */
function parseXmlRestricted(input, options = {}) {
  const limits = resolveXmlLimits(options.limits);
  const decoded = decodeInput(input);
  if (!decoded.ok) {
    const message =
      decoded.keyword === 'invalidChar'
        ? 'input contains a character that is not legal in XML 1.0'
        : 'input must be valid UTF-8 XML text';
    return { ok: false, code: 'INVALID_XML', errors: [issue('$', decoded.keyword, message)] };
  }
  const { text } = decoded;
  if (decoded.bytes > limits.xml_bytes) {
    return limitFailure('maxBytes', `XML input is ${decoded.bytes} bytes; limit is ${limits.xml_bytes}`, '$');
  }

  const n = text.length;
  let i = 0;
  /** @type {XmlNode[]} */
  const stack = [];
  /** @type {XmlNode | null} */
  let root = null;
  let rootClosed = false;
  let elementCount = 0;

  /** @param {string} keyword @param {string} message @param {string} [path] */
  const bad = (keyword, message, path = '$') => ({
    ok: /** @type {const} */ (false),
    code: /** @type {const} */ ('INVALID_XML'),
    errors: [issue(path, keyword, message)],
  });

  while (i < n) {
    const code = text.charCodeAt(i);
    if (code !== 0x3c /* < */) {
      const next = text.indexOf('<', i);
      const end = next === -1 ? n : next;
      const chunk = text.slice(i, end);
      if (chunk.includes(']]>')) return bad('cdataEnd', '"]]>" is not allowed in character data');
      const decodedChunk = decodeEntities(chunk);
      if (!decodedChunk.ok) return bad(decodedChunk.keyword, decodedChunk.message);
      if (stack.length === 0) {
        if (decodedChunk.value.trim() !== '') {
          return bad('textOutsideRoot', 'character data is not allowed outside the root element');
        }
      } else if (decodedChunk.value !== '') {
        const parent = stack[stack.length - 1];
        parent.children.push({ text: decodedChunk.value });
        parent.text += decodedChunk.value;
      }
      i = end;
      continue;
    }

    if (text.startsWith('<!--', i)) return bad('comment', 'XML comments are not allowed');
    if (text.startsWith('<![CDATA[', i)) return bad('cdata', 'CDATA sections are not allowed');
    if (text.startsWith('<?', i)) {
      return bad('processingInstruction', 'processing instructions and the XML declaration are not allowed');
    }
    if (text.startsWith('<!', i)) {
      return bad('doctype', 'DOCTYPE/entity declarations are not allowed');
    }

    if (text.startsWith('</', i)) {
      let j = i + 2;
      const nameStart = j;
      if (j >= n || !isNameStartCode(text.charCodeAt(j))) return bad('malformed', 'malformed closing tag');
      j += 1;
      while (j < n && isNameCharCode(text.charCodeAt(j))) j += 1;
      const name = text.slice(nameStart, j);
      while (j < n && isWhitespaceCode(text.charCodeAt(j))) j += 1;
      if (j >= n) return bad('unterminatedTag', `unterminated closing tag </${name}>`);
      if (text.charCodeAt(j) !== 0x3e /* > */) return bad('malformed', `malformed closing tag </${name}>`);
      j += 1;
      const current = stack.pop();
      if (!current) return bad('unexpectedClose', `unexpected closing tag </${name}>`);
      if (current.name !== name) {
        return bad('mismatchedTag', `closing tag </${name}> does not match open element <${current.name}>`);
      }
      if (stack.length === 0) rootClosed = true;
      i = j;
      continue;
    }

    /* opening tag */
    let j = i + 1;
    const nameStart = j;
    if (j >= n || !isNameStartCode(text.charCodeAt(j))) return bad('malformed', 'malformed element name');
    j += 1;
    while (j < n && isNameCharCode(text.charCodeAt(j))) j += 1;
    const name = text.slice(nameStart, j);
    if (RESERVED_NAMES.has(name)) return bad('invalidName', `element name "${name}" is not allowed`);

    /** @type {Record<string, string>} */
    const attributes = {};
    let attributeCount = 0;
    let selfClosing = false;
    for (;;) {
      while (j < n && isWhitespaceCode(text.charCodeAt(j))) j += 1;
      if (j >= n) return bad('unterminatedTag', `unterminated start tag <${name}>`);
      const ch = text.charCodeAt(j);
      if (ch === 0x3e /* > */) {
        j += 1;
        break;
      }
      if (ch === 0x2f /* / */) {
        if (text.charCodeAt(j + 1) !== 0x3e) return bad('malformed', `malformed self-closing tag <${name}>`);
        j += 2;
        selfClosing = true;
        break;
      }
      if (!isNameStartCode(ch)) return bad('malformedAttribute', `malformed attribute in <${name}>`);
      const attrStart = j;
      j += 1;
      while (j < n && isNameCharCode(text.charCodeAt(j))) j += 1;
      const attrName = text.slice(attrStart, j);
      if (attrName === 'xmlns' || attrName === 'xmlns:') {
        return bad('namespace', 'namespace declarations are not allowed');
      }
      if (attrName.includes(':')) return bad('namespace', 'namespace prefixes are not allowed');
      if (RESERVED_NAMES.has(attrName)) return bad('invalidName', `attribute name "${attrName}" is not allowed`);
      while (j < n && isWhitespaceCode(text.charCodeAt(j))) j += 1;
      if (j >= n || text.charCodeAt(j) !== 0x3d /* = */) {
        return bad('malformedAttribute', `attribute "${attrName}" has no value`);
      }
      j += 1;
      while (j < n && isWhitespaceCode(text.charCodeAt(j))) j += 1;
      const quote = text.charCodeAt(j);
      if (quote !== 0x22 /* " */ && quote !== 0x27 /* ' */) {
        return bad('attributeNotQuoted', `attribute "${attrName}" value must be quoted`);
      }
      j += 1;
      const valueStart = j;
      while (j < n && text.charCodeAt(j) !== quote) {
        if (text.charCodeAt(j) === 0x3c) {
          return bad('malformedAttribute', `"<" is not allowed in attribute values`);
        }
        j += 1;
      }
      if (j >= n) return bad('unterminatedTag', `unterminated attribute value for "${attrName}"`);
      const rawValue = text.slice(valueStart, j);
      j += 1;
      attributeCount += 1;
      if (attributeCount > limits.xml_attributes_per_element) {
        return limitFailure(
          'maxAttributes',
          `element <${name}> exceeds ${limits.xml_attributes_per_element} attributes`,
          '$',
        );
      }
      if (Object.prototype.hasOwnProperty.call(attributes, attrName)) {
        return bad('duplicateAttribute', `duplicate attribute "${attrName}" on <${name}>`);
      }
      const value = decodeEntities(rawValue);
      if (!value.ok) return bad(value.keyword, value.message);
      attributes[attrName] = value.value;
    }

    elementCount += 1;
    if (elementCount > limits.xml_elements) {
      return limitFailure('maxElements', `XML input exceeds ${limits.xml_elements} elements`, '$');
    }
    /** @type {XmlNode} */
    const node = { name, attributes, children: [], text: '' };
    if (stack.length === 0) {
      if (root !== null) return bad('multipleRoots', 'XML document must have exactly one root element');
      root = node;
    } else {
      stack[stack.length - 1].children.push(node);
    }
    if (stack.length + 1 > limits.xml_depth) {
      return limitFailure('maxDepth', `XML nesting exceeds depth ${limits.xml_depth}`, '$');
    }
    if (!selfClosing) {
      stack.push(node);
    } else if (stack.length === 0) {
      rootClosed = true;
    }
    i = j;
  }

  if (stack.length > 0) {
    return bad('unterminatedTag', `element <${stack[stack.length - 1].name}> is not closed`);
  }
  if (root === null) return bad('noRoot', 'XML document has no root element');
  return { ok: true, root };
}

/**
 * @param {string} keyword
 * @param {string} message
 * @param {string} path
 * @returns {{ok: false, code: 'LIMIT_EXCEEDED', errors: Array<{path: string, keyword: string, message: string}>}}
 */
function limitFailure(keyword, message, path) {
  return { ok: false, code: 'LIMIT_EXCEEDED', errors: [issue(path, keyword, message)] };
}

/* -------------------------------------------------------------------------- */
/* style whitelist                                                             */
/* -------------------------------------------------------------------------- */

const LOCAL_FONTS = new Set([
  'helvetica',
  'arial',
  'verdana',
  'tahoma',
  'georgia',
  'times new roman',
  'courier new',
  'consolas',
  'monospace',
  'sans-serif',
  'serif',
]);
const SHAPE_VALUES = new Set(['rectangle', 'ellipse', 'rhombus', 'note', 'text', 'cylinder']);
const EDGE_STYLE_VALUES = new Set([
  'orthogonalEdgeStyle',
  'elbowEdgeStyle',
  'entityRelationEdgeStyle',
  'segmentEdgeStyle',
]);
const ARROW_VALUES = new Set(['none', 'classic', 'block', 'open', 'oval', 'diamond', 'thin']);
const BARE_TOKENS = new Set(['text', 'ellipse', 'rounded', 'rhombus', 'note', 'cylinder']);
const FORBIDDEN_STYLE_KEYS = new Set(['image', 'link', 'url']);

/** @param {string} value */
function isLocalColor(value) {
  if (value === 'none') return true;
  return /^#(?:[0-9A-Fa-f]{3}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/.test(value);
}

/**
 * Validate one key=value style entry against the closed whitelist. Returns
 * `{ok:true, value}` or `{ok:false, code, keyword, message}`.
 * @param {string} key
 * @param {string} value
 * @returns {{ok: true} | {ok: false, code: string, keyword: string, message: string}}
 */
function validateStyleEntry(key, value) {
  if (FORBIDDEN_STYLE_KEYS.has(key)) {
    return { ok: false, code: 'INVALID_XML', keyword: 'forbiddenStyle', message: `style "${key}" is not allowed` };
  }
  if (/(?:javascript|data|file|https?):/i.test(value) || value.startsWith('//')) {
    return {
      ok: false,
      code: 'INVALID_XML',
      keyword: 'remoteResourceStyle',
      message: `style "${key}" references a remote/script resource`,
    };
  }
  switch (key) {
    case 'rounded':
    case 'dashed':
    case 'endFill':
    case 'startFill':
      if (value !== '0' && value !== '1') {
        return { ok: false, code: 'INVALID_XML', keyword: 'styleValue', message: `style "${key}" must be 0 or 1` };
      }
      return { ok: true };
    case 'whiteSpace':
      if (value !== 'wrap' && value !== 'nowrap') {
        return { ok: false, code: 'INVALID_XML', keyword: 'styleValue', message: `style "whiteSpace" has an invalid value` };
      }
      return { ok: true };
    case 'fillColor':
    case 'strokeColor':
    case 'fontColor':
      if (!isLocalColor(value)) {
        return { ok: false, code: 'INVALID_XML', keyword: 'styleValue', message: `style "${key}" must be a local color` };
      }
      return { ok: true };
    case 'fontSize':
      if (!/^(?:[1-9]|[1-9][0-9]|100)$/.test(value)) {
        return { ok: false, code: 'INVALID_XML', keyword: 'styleValue', message: 'style "fontSize" must be 1..100' };
      }
      return { ok: true };
    case 'fontFamily':
      if (!LOCAL_FONTS.has(value.toLowerCase())) {
        return {
          ok: false,
          code: 'INVALID_XML',
          keyword: 'remoteFont',
          message: 'style "fontFamily" must be a local font family',
        };
      }
      return { ok: true };
    case 'fontStyle':
      if (!/^[0-3]$/.test(value)) {
        return { ok: false, code: 'INVALID_XML', keyword: 'styleValue', message: 'style "fontStyle" must be 0..3' };
      }
      return { ok: true };
    case 'strokeWidth':
      if (!/^(?:0|[1-9][0-9]?)$/.test(value)) {
        return { ok: false, code: 'INVALID_XML', keyword: 'styleValue', message: 'style "strokeWidth" must be 0..99' };
      }
      return { ok: true };
    case 'align':
      if (value !== 'left' && value !== 'center' && value !== 'right') {
        return { ok: false, code: 'INVALID_XML', keyword: 'styleValue', message: 'style "align" has an invalid value' };
      }
      return { ok: true };
    case 'verticalAlign':
      if (value !== 'top' && value !== 'middle' && value !== 'bottom') {
        return { ok: false, code: 'INVALID_XML', keyword: 'styleValue', message: 'style "verticalAlign" has an invalid value' };
      }
      return { ok: true };
    case 'shape':
      if (value === 'image' || value === 'link' || value === 'url') {
        return { ok: false, code: 'INVALID_XML', keyword: 'forbiddenStyle', message: 'style "shape" cannot be image/link/url' };
      }
      if (!SHAPE_VALUES.has(value)) {
        return { ok: false, code: 'UNSUPPORTED', keyword: 'unknownShape', message: `shape "${value}" is not supported` };
      }
      return { ok: true };
    case 'edgeStyle':
      if (!EDGE_STYLE_VALUES.has(value)) {
        return { ok: false, code: 'UNSUPPORTED', keyword: 'unknownShape', message: `edgeStyle "${value}" is not supported` };
      }
      return { ok: true };
    case 'endArrow':
    case 'startArrow':
      if (!ARROW_VALUES.has(value)) {
        return { ok: false, code: 'INVALID_XML', keyword: 'styleValue', message: `style "${key}" has an invalid arrow value` };
      }
      return { ok: true };
    case 'html':
      if (value !== '0') {
        return { ok: false, code: 'INVALID_XML', keyword: 'forbiddenStyle', message: 'style "html=1" is not allowed' };
      }
      return { ok: true };
    default:
      return { ok: false, code: 'UNSUPPORTED', keyword: 'unknownStyleKey', message: `style key "${key}" is not supported` };
  }
}

/**
 * Parse and validate a drawio `style` attribute.
 * @param {string} raw
 * @returns {Record<string, string>} key→value; bare tokens are stored as ''
 */
function parseDrawioStyle(raw) {
  if (typeof raw !== 'string') {
    throw new BoundaryError('INVALID_XML', 'styleType', 'style must be a string', '$');
  }
  if (raw.length > LIMITS.drawio_style_length) {
    throw new BoundaryError(
      'LIMIT_EXCEEDED',
      'styleLength',
      `style exceeds ${LIMITS.drawio_style_length} characters`,
      '$',
    );
  }
  const parts = raw.split(';');
  if (parts.length > LIMITS.drawio_style_entries) {
    throw new BoundaryError(
      'LIMIT_EXCEEDED',
      'styleEntries',
      `style exceeds ${LIMITS.drawio_style_entries} entries`,
      '$',
    );
  }
  const entries = [];
  for (const part of parts) {
    if (part === '') continue;
    const eq = part.indexOf('=');
    if (eq === -1) entries.push({ key: part, value: '' });
    else entries.push({ key: part.slice(0, eq), value: part.slice(eq + 1) });
  }
  // Pass 1: dangerous/forbidden constructs, so they are never classified as a
  // mere unknown key and skipped.
  for (const entry of entries) {
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(entry.key)) {
      throw new BoundaryError('INVALID_XML', 'styleKey', `style key "${entry.key}" is malformed`, '$');
    }
    if (/(?:javascript|data|file|https?):/i.test(entry.value) || entry.value.startsWith('//')) {
      throw new BoundaryError(
        'INVALID_XML',
        'remoteResourceStyle',
        `style "${entry.key}" references a remote/script resource`,
        '$',
      );
    }
    if (FORBIDDEN_STYLE_KEYS.has(entry.key)) {
      throw new BoundaryError('INVALID_XML', 'forbiddenStyle', `style "${entry.key}" is not allowed`, '$');
    }
    if (entry.key === 'html' && entry.value !== '0') {
      throw new BoundaryError('INVALID_XML', 'forbiddenStyle', 'style "html=1" is not allowed', '$');
    }
    if (entry.key === 'fontFamily' && !LOCAL_FONTS.has(entry.value.toLowerCase())) {
      throw new BoundaryError('INVALID_XML', 'remoteFont', 'style "fontFamily" must be a local font family', '$');
    }
    if (entry.key === 'shape' && (entry.value === 'image' || entry.value === 'link' || entry.value === 'url')) {
      throw new BoundaryError('INVALID_XML', 'forbiddenStyle', 'style "shape" cannot be image/link/url', '$');
    }
  }
  // Pass 2: closed whitelist. Bare tokens are a fixed enum as well.
  /** @type {Record<string, string>} */
  const style = {};
  for (const entry of entries) {
    if (entry.value === '') {
      if (!BARE_TOKENS.has(entry.key)) {
        throw new BoundaryError('UNSUPPORTED', 'unknownStyleKey', `style token "${entry.key}" is not supported`, '$');
      }
      style[entry.key] = '';
      continue;
    }
    const verdict = validateStyleEntry(entry.key, entry.value);
    if (!verdict.ok) throw new BoundaryError(verdict.code, verdict.keyword, verdict.message, '$');
    style[entry.key] = entry.value;
  }
  return style;
}

/* -------------------------------------------------------------------------- */
/* mxGraph model serialization                                                 */
/* -------------------------------------------------------------------------- */

const MXGRAPH_STATIC_ATTRS = Object.freeze({
  dx: '0',
  dy: '0',
  grid: '1',
  gridSize: '10',
  guides: '1',
  tooltips: '1',
  connect: '1',
  arrows: '1',
  fold: '1',
  page: '1',
  pageScale: '1',
  pageWidth: '827',
  pageHeight: '1169',
  math: '0',
  shadow: '0',
});

const DATA_ATTRIBUTES = Object.freeze([
  'data_origin',
  'data_certainty',
  'data_base_digest',
  'data_diagram_id',
  'data_cell_kind',
]);

/** Short keys used by the parsed cell `data` object. */
const DATA_SHORT_KEYS = Object.freeze({
  data_origin: 'origin',
  data_certainty: 'certainty',
  data_base_digest: 'base_digest',
  data_diagram_id: 'diagram_id',
  data_cell_kind: 'cell_kind',
});

/**
 * Normalize a model style (string or parsed key→value record) to its
 * serializable `k=v;` form.
 * @param {unknown} style
 * @returns {string}
 */
function modelStyleString(style) {
  if (typeof style === 'string') return style;
  if (!isRecord(style)) return '';
  return Object.entries(style)
    .map(([key, value]) => (value === '' || value === undefined || value === null ? key : `${key}=${value}`))
    .join(';');
}

/** @param {unknown} value @param {string} name */
function finiteNumberAttr(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new DiagramError('INVALID_INPUT', `${name} must be a finite number`);
  }
  return String(value);
}

/**
 * @param {{x?: number, y?: number, width?: number, height?: number, relative?: boolean, as?: string, points?: Array<{x: number, y: number, as?: string}>}} geometry
 * @returns {string}
 */
function serializeGeometry(geometry) {
  const attrs = [];
  for (const key of ['x', 'y', 'width', 'height']) {
    if (geometry[key] !== undefined && geometry[key] !== null) {
      attrs.push(`${key}="${finiteNumberAttr(geometry[key], `geometry.${key}`)}"`);
    }
  }
  if (geometry.relative === true) attrs.push('relative="1"');
  const as = geometry.as ?? 'geometry';
  attrs.push(`as="${escXmlAttr(as)}"`);
  const points = Array.isArray(geometry.points) ? geometry.points : [];
  const directPoints = points.filter(
    (point) => point.as === 'sourcePoint' || point.as === 'targetPoint' || point.as === 'offset',
  );
  const plainPoints = points.filter(
    (point) => !(point.as === 'sourcePoint' || point.as === 'targetPoint' || point.as === 'offset'),
  );
  const children = [];
  for (const point of directPoints) {
    children.push(
      `<mxPoint x="${finiteNumberAttr(point.x, 'point.x')}" y="${finiteNumberAttr(point.y, 'point.y')}" as="${escXmlAttr(point.as)}" />`,
    );
  }
  if (plainPoints.length > 0) {
    const pointsXml = plainPoints
      .map(
        (point) =>
          `<mxPoint x="${finiteNumberAttr(point.x, 'point.x')}" y="${finiteNumberAttr(point.y, 'point.y')}" />`,
      )
      .join('\n');
    children.push(`<Array as="points">\n${pointsXml}\n</Array>`);
  }
  const attrText = attrs.join(' ');
  if (children.length === 0) return `<mxGeometry ${attrText} />`;
  return `<mxGeometry ${attrText}>\n${children.join('\n')}\n</mxGeometry>`;
}

/**
 * @param {any} cell
 * @returns {string}
 */
function serializeMxCell(cell) {
  const id = cell.id;
  if (typeof id !== 'string' || id.length === 0) {
    throw new DiagramError('INVALID_INPUT', 'every mxCell needs a non-empty string id');
  }
  const attrs = [`id="${escXmlAttr(id)}"`];
  if (cell.parent !== undefined && cell.parent !== null) attrs.push(`parent="${escXmlAttr(cell.parent)}"`);
  if (cell.value !== undefined && cell.value !== null) attrs.push(`value="${escXmlAttr(cell.value)}"`);
  const style = modelStyleString(cell.style);
  if (style !== '') attrs.push(`style="${escXmlAttr(style)}"`);
  if (cell.vertex === true) attrs.push('vertex="1"');
  if (cell.edge === true) attrs.push('edge="1"');
  if (cell.source !== undefined && cell.source !== null) attrs.push(`source="${escXmlAttr(cell.source)}"`);
  if (cell.target !== undefined && cell.target !== null) attrs.push(`target="${escXmlAttr(cell.target)}"`);
  if (cell.visible === false) attrs.push('visible="0"');
  if (cell.visible === true) attrs.push('visible="1"');
  const nestedData = isRecord(cell.data) ? cell.data : null;
  for (const key of DATA_ATTRIBUTES) {
    const value =
      cell[key] !== undefined && cell[key] !== null
        ? cell[key]
        : nestedData
          ? nestedData[DATA_SHORT_KEYS[key]]
          : undefined;
    if (value !== undefined && value !== null) attrs.push(`${key}="${escXmlAttr(value)}"`);
  }
  const children = [];
  if (cell.geometry) children.push(serializeGeometry(cell.geometry));
  const open = `<mxCell ${attrs.join(' ')}`;
  if (children.length === 0) return `${open} />`;
  return `${open}>\n${children.join('\n')}\n</mxCell>`;
}

/**
 * Serialize the `<mxGraphModel>` element. `root_cells` is the ordered list of
 * content cells; the model root cell `0` and the layer cells are emitted first.
 * Callers are responsible for deterministic cell order (exportDrawio sorts by
 * id); canonicalMxGraph ignores order entirely.
 *
 * @param {{root_cells: Array<any>, layers?: Array<{id: string, value?: string, visible?: boolean}>}} model
 * @returns {string}
 */
function serializeMxGraphModel(model) {
  if (!isRecord(model) || !Array.isArray(model.root_cells)) {
    throw new DiagramError('INVALID_INPUT', 'model.root_cells must be an array');
  }
  const layers = Array.isArray(model.layers) ? model.layers : [];
  const layerIds = new Set(layers.map((layer) => String(layer.id)));
  /** @type {string[]} */
  const cellsXml = [];
  const ownCell0 = model.root_cells.find((cell) => String(cell?.id) === '0');
  cellsXml.push(serializeMxCell(ownCell0 ?? { id: '0' }));
  for (const layer of layers) {
    cellsXml.push(
      serializeMxCell({
        id: String(layer.id),
        parent: '0',
        value: layer.value,
        visible: layer.visible,
      }),
    );
  }
  for (const cell of model.root_cells) {
    const id = String(cell?.id);
    if (id === '0' || layerIds.has(id)) continue;
    cellsXml.push(serializeMxCell(cell));
  }
  const attrs = Object.entries(MXGRAPH_STATIC_ATTRS)
    .map(([key, value]) => `${key}="${value}"`)
    .join(' ');
  return `<mxGraphModel ${attrs}>\n<root>\n${cellsXml.join('\n')}\n</root>\n</mxGraphModel>`;
}

/* -------------------------------------------------------------------------- */
/* mxGraph model parsing                                                       */
/* -------------------------------------------------------------------------- */

class BoundaryError extends Error {
  /**
   * @param {'INVALID_XML' | 'UNSUPPORTED' | 'LIMIT_EXCEEDED'} code
   * @param {string} keyword
   * @param {string} message
   * @param {string} [path]
   */
  constructor(code, keyword, message, path = '$') {
    super(message);
    this.name = 'BoundaryError';
    this.code = code;
    this.report = { path, keyword, message };
  }
}

/** @param {string} message @param {string} [path] @returns {never} */
function reject(message, path) {
  throw new BoundaryError('INVALID_XML', 'invalid', message, path);
}

/** @param {string} message @param {string} [path] @returns {never} */
function rejectUnsupported(message, path) {
  throw new BoundaryError('UNSUPPORTED', 'unsupported', message, path);
}

/** @param {string} keyword @param {string} message @param {string} [path] @returns {never} */
function rejectLimit(keyword, message, path) {
  throw new BoundaryError('LIMIT_EXCEEDED', keyword, message, path);
}

const MXFILE_ATTRS = new Set(['host', 'version', 'modified', 'agent', 'etag']);
const DIAGRAM_ATTRS = new Set(['id', 'name']);
const MXGRAPH_ATTRS = new Set([
  'dx',
  'dy',
  'grid',
  'gridSize',
  'guides',
  'tooltips',
  'connect',
  'arrows',
  'fold',
  'page',
  'pageScale',
  'pageWidth',
  'pageHeight',
  'math',
  'shadow',
]);
const CELL_ATTRS = new Set([
  'id',
  'value',
  'style',
  'parent',
  'source',
  'target',
  'vertex',
  'edge',
  'visible',
  ...DATA_ATTRIBUTES,
]);
const GEOMETRY_ATTRS = new Set(['x', 'y', 'width', 'height', 'relative', 'as']);
const POINT_ATTRS = new Set(['x', 'y', 'as']);
const ARRAY_ATTRS = new Set(['as']);
const POINT_AS_VALUES = new Set(['sourcePoint', 'targetPoint', 'offset']);

/**
 * @typedef {{id: string, parent: string | null, value: string, style: Record<string, string>, vertex: boolean, edge: boolean, source: string | null, target: string | null, visible: boolean | null, data: {origin: string | null, certainty: string | null, base_digest: string | null, diagram_id: string | null, cell_kind: string | null}, geometry: null | {x: number | null, y: number | null, width: number | null, height: number | null, relative: boolean | null, as: string, points: Array<{x: number, y: number, as: string | null}>}}} MxCell
 */

/**
 * @param {XmlNode} node
 * @param {string} elementName
 * @returns {XmlNode[]}
 */
function elementChildren(node, elementName) {
  /** @type {XmlNode[]} */
  const elements = [];
  for (const child of node.children) {
    if (Array.isArray(child.children)) elements.push(child);
  }
  for (const element of elements) {
    if (element.name !== elementName) {
      rejectUnsupported(`unknown element <${element.name}> inside <${node.name}>`, `$.${node.name}`);
    }
  }
  return elements;
}

/**
 * @param {XmlNode} node
 * @param {Set<string>} allowed
 */
function validateAttributes(node, allowed) {
  for (const key of Object.keys(node.attributes)) {
    if (!allowed.has(key)) {
      rejectUnsupported(`attribute "${key}" is not supported on <${node.name}>`, `$.${node.name}.${key}`);
    }
  }
}

/** @param {XmlNode} node @param {string} name */
function attr(node, name) {
  return Object.prototype.hasOwnProperty.call(node.attributes, name) ? node.attributes[name] : undefined;
}

/** @param {XmlNode} node @param {string} name @param {string} path */
function requiredAttr(node, name, path) {
  const value = attr(node, name);
  if (value === undefined || value === '') reject(`<${node.name}> requires attribute "${name}"`, path);
  return value;
}

const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

/** @param {string} value @param {string} what @param {string} path */
function validateSafeId(value, what, path) {
  if (!SAFE_ID_PATTERN.test(value)) reject(`${what} "${value}" is not a safe id`, path);
}

/** @param {string} value @param {string} name @param {string} path */
function validatePlainTextValue(value, name, path) {
  if (utf8Length(value) > LIMITS.drawio_value) rejectLimit('maxValue', `${name} exceeds ${LIMITS.drawio_value} bytes`, path);
  if (looksLikeMarkup(value)) reject(`value of ${name} contains HTML/script markup`, path);
}

/**
 * @param {XmlNode} node
 * @param {string} name
 * @param {string} path
 * @returns {number | null}
 */
function optionalFiniteAttr(node, name, path) {
  const raw = attr(node, name);
  if (raw === undefined) return null;
  if (!/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(raw)) {
    reject(`attribute "${name}" must be a finite number`, path);
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) reject(`attribute "${name}" must be a finite number`, path);
  return value;
}

/**
 * @param {XmlNode} node
 * @param {number} maxPoints
 * @returns {{x: number | null, y: number | null, width: number | null, height: number | null, relative: boolean | null, as: string, points: Array<{x: number, y: number, as: string | null}>}}
 */
function buildGeometry(node, maxPoints) {
  const path = '$.mxGeometry';
  validateAttributes(node, GEOMETRY_ATTRS);
  const as = attr(node, 'as') ?? 'geometry';
  if (as !== 'geometry') rejectUnsupported(`geometry as="${as}" is not supported`, path);
  const relativeRaw = attr(node, 'relative');
  if (relativeRaw !== undefined && relativeRaw !== '0' && relativeRaw !== '1') {
    reject('attribute "relative" must be 0 or 1', path);
  }
  /** @type {{x: number | null, y: number | null, width: number | null, height: number | null, relative: boolean | null, as: string, points: Array<{x: number, y: number, as: string | null}>}} */
  const geometry = {
    x: optionalFiniteAttr(node, 'x', path),
    y: optionalFiniteAttr(node, 'y', path),
    width: optionalFiniteAttr(node, 'width', path),
    height: optionalFiniteAttr(node, 'height', path),
    relative: relativeRaw === undefined ? null : relativeRaw === '1',
    as,
    points: [],
  };
  for (const child of node.children) {
    if (!Array.isArray(child.children)) continue;
    if (child.name === 'mxPoint') {
      geometry.points.push(buildPoint(child));
    } else if (child.name === 'Array') {
      validateAttributes(child, ARRAY_ATTRS);
      const arrayAs = attr(child, 'as');
      if (arrayAs !== 'points') rejectUnsupported(`Array as="${arrayAs ?? ''}" is not supported`, path);
      for (const pointNode of elementChildren(child, 'mxPoint')) {
        const point = buildPoint(pointNode);
        if (point.as !== null) reject('points inside <Array as="points"> cannot carry an "as" attribute', path);
        geometry.points.push(point);
      }
    } else {
      rejectUnsupported(`unknown geometry child <${child.name}>`, path);
    }
  }
  if (geometry.points.length > maxPoints) {
    rejectLimit('maxPoints', `geometry exceeds ${maxPoints} points`, path);
  }
  return geometry;
}

/**
 * @param {XmlNode} node
 * @returns {{x: number, y: number, as: string | null}}
 */
function buildPoint(node) {
  validateAttributes(node, POINT_ATTRS);
  const path = '$.mxPoint';
  const x = optionalFiniteAttr(node, 'x', path);
  const y = optionalFiniteAttr(node, 'y', path);
  if (x === null || y === null) reject('mxPoint requires "x" and "y"', path);
  const as = attr(node, 'as');
  if (as !== undefined && !POINT_AS_VALUES.has(as)) {
    rejectUnsupported(`mxPoint as="${as}" is not supported`, path);
  }
  return { x, y, as: as ?? null };
}

/**
 * @param {XmlNode} node
 * @returns {MxCell}
 */
function buildCell(node) {
  validateAttributes(node, CELL_ATTRS);
  const id = requiredAttr(node, 'id', '$.mxCell.id');
  validateSafeId(id, 'cell id', '$.mxCell.id');
  const parent = attr(node, 'parent');
  if (parent !== undefined) validateSafeId(parent, 'cell parent', '$.mxCell.parent');
  const value = attr(node, 'value') ?? '';
  validatePlainTextValue(value, 'mxCell value', '$.mxCell.value');
  const styleRaw = attr(node, 'style') ?? '';
  const style = parseDrawioStyle(styleRaw);
  const vertex = readFlag(node, 'vertex');
  const edge = readFlag(node, 'edge');
  const visible = readFlagOrNull(node, 'visible');
  const source = attr(node, 'source');
  const target = attr(node, 'target');
  if (source !== undefined) validateSafeId(source, 'edge source', '$.mxCell.source');
  if (target !== undefined) validateSafeId(target, 'edge target', '$.mxCell.target');

  const data = {
    origin: readEnum(node, 'data_origin', ['evidence', 'annotation']),
    certainty: readEnum(node, 'data_certainty', ['exact', 'may', 'unresolved', 'unknown']),
    base_digest: readDigest(node, 'data_base_digest'),
    diagram_id: readDisplayId(node, 'data_diagram_id'),
    cell_kind: readDisplayToken(node, 'data_cell_kind'),
  };

  let geometry = null;
  const cellElements = elementChildren(node, 'mxGeometry');
  if (cellElements.length > 1) reject('mxCell may contain at most one mxGeometry', '$.mxCell');
  if (cellElements.length === 1) geometry = buildGeometry(cellElements[0], LIMITS.mx_geometry_points);
  if (node.text.trim() !== '') reject('mxCell cannot contain character data', '$.mxCell');

  return { id, parent: parent ?? null, value, style, vertex, edge, source: source ?? null, target: target ?? null, visible, data, geometry };
}

/** @param {XmlNode} node @param {string} name */
function readFlag(node, name) {
  const raw = attr(node, name);
  if (raw === undefined) return false;
  if (raw !== '0' && raw !== '1') reject(`attribute "${name}" must be 0 or 1`, `$.mxCell.${name}`);
  return raw === '1';
}

/** @param {XmlNode} node @param {string} name */
function readFlagOrNull(node, name) {
  const raw = attr(node, name);
  if (raw === undefined) return null;
  if (raw !== '0' && raw !== '1') reject(`attribute "${name}" must be 0 or 1`, `$.mxCell.${name}`);
  return raw === '1';
}

/** @param {XmlNode} node @param {string} name @param {string[]} allowed */
function readEnum(node, name, allowed) {
  const raw = attr(node, name);
  if (raw === undefined) return null;
  if (!allowed.includes(raw)) reject(`attribute "${name}" has an unsupported value`, `$.mxCell.${name}`);
  return raw;
}

/** @param {XmlNode} node @param {string} name */
function readDigest(node, name) {
  const raw = attr(node, name);
  if (raw === undefined) return null;
  if (!/^[0-9a-f]{64}$/.test(raw)) reject(`attribute "${name}" must be a sha256 hex digest`, `$.mxCell.${name}`);
  return raw;
}

/** @param {XmlNode} node @param {string} name */
function readDisplayId(node, name) {
  const raw = attr(node, name);
  if (raw === undefined) return null;
  validateSafeId(raw, `attribute "${name}"`, `$.mxCell.${name}`);
  return raw;
}

/** @param {XmlNode} node @param {string} name */
function readDisplayToken(node, name) {
  const raw = attr(node, name);
  if (raw === undefined) return null;
  if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(raw)) {
    reject(`attribute "${name}" is malformed`, `$.mxCell.${name}`);
  }
  return raw;
}

/**
 * Parse an uncompressed `.drawio` / `<mxGraphModel>` payload into the
 * restricted cell model. Compressed diagrams, unknown elements, unknown
 * attributes and unknown shapes are UNSUPPORTED (never stripped); malformed
 * or dangerous values are INVALID_XML.
 *
 * @param {string | Uint8Array} input
 * @param {{limits?: Record<string, number>}} [options]
 * @returns {{ok: true, document: {cells: MxCell[], layers: Array<{id: string, value: string}>}} | {ok: false, code: string, errors: Array<{path: string, keyword: string, message: string}>}}
 */
function parseDrawioXml(input, options = {}) {
  const customLimits = isRecord(options.limits) ? options.limits : {};
  const parsed = parseXmlRestricted(input, {
    limits: {
      xml_bytes: customLimits.xml_bytes ?? LIMITS.xml_bytes,
      xml_depth: customLimits.xml_depth ?? LIMITS.xml_depth,
      xml_elements: customLimits.xml_elements ?? LIMITS.xml_elements,
      xml_attributes_per_element: customLimits.xml_attributes_per_element ?? LIMITS.xml_attributes_per_element,
    },
  });
  if (!parsed.ok) return parsed;
  try {
    return { ok: true, document: buildDrawioDocument(parsed.root, customLimits) };
  } catch (error) {
    if (error instanceof BoundaryError) {
      return { ok: false, code: error.code, errors: [error.report] };
    }
    throw error;
  }
}

/**
 * @param {XmlNode} rootNode
 * @param {Record<string, any>} customLimits
 * @returns {{cells: MxCell[], layers: Array<{id: string, value: string}>}}
 */
function buildDrawioDocument(rootNode, customLimits) {
  const maxCells = Number.isSafeInteger(customLimits.mx_cells) && customLimits.mx_cells >= 1
    ? customLimits.mx_cells
    : LIMITS.mx_cells;

  /** @type {XmlNode | null} */
  let graphModelNode = null;
  if (rootNode.name === 'mxfile') {
    validateAttributes(rootNode, MXFILE_ATTRS);
    const diagrams = elementChildren(rootNode, 'diagram');
    if (diagrams.length === 0) reject('mxfile must contain a diagram element', '$.mxfile');
    if (diagrams.length > 1) rejectUnsupported('multi-page diagrams are not supported', '$.mxfile');
    graphModelNode = readDiagram(diagrams[0]);
  } else if (rootNode.name === 'diagram') {
    graphModelNode = readDiagram(rootNode);
  } else if (rootNode.name === 'mxGraphModel') {
    graphModelNode = rootNode;
  } else {
    rejectUnsupported(`unknown root element <${rootNode.name}>`, '$');
  }

  validateAttributes(graphModelNode, MXGRAPH_ATTRS);
  const roots = elementChildren(graphModelNode, 'root');
  if (roots.length !== 1) reject('mxGraphModel must contain exactly one root element', '$.mxGraphModel');
  const rootElement = roots[0];
  if (Object.keys(rootElement.attributes).length > 0) reject('root element must not have attributes', '$.root');
  if (rootElement.text.trim() !== '') reject('root element cannot contain character data', '$.root');

  const cellNodes = elementChildren(rootElement, 'mxCell');
  if (cellNodes.length > maxCells) rejectLimit('maxCells', `document exceeds ${maxCells} cells`, '$.root');

  /** @type {MxCell[]} */
  const cells = cellNodes.map((cellNode) => buildCell(cellNode));
  /** @type {Map<string, MxCell>} */
  const byId = new Map();
  for (const cell of cells) {
    if (byId.has(cell.id)) reject(`duplicate cell id "${cell.id}"`, '$.root');
    byId.set(cell.id, cell);
  }
  const rootCell = byId.get('0');
  if (!rootCell) reject('document must contain root cell 0', '$.root');
  if (rootCell.parent !== null) reject('root cell 0 must not have a parent', '$.root');
  if (rootCell.vertex || rootCell.edge) reject('root cell 0 cannot be a vertex or edge', '$.root');

  /** @type {MxCell[]} */
  const layerCells = [];
  /** @type {MxCell[]} */
  const contentCells = [];
  for (const cell of cells) {
    if (cell.id === '0') continue;
    if (cell.parent === '0') layerCells.push(cell);
    else contentCells.push(cell);
  }
  if (layerCells.length === 0) reject('document must contain at least one layer cell (parent 0)', '$.root');
  const layerIds = new Set(layerCells.map((layer) => layer.id));

  for (const layer of layerCells) {
    if (layer.vertex || layer.edge || layer.geometry) {
      rejectUnsupported(`layer cell "${layer.id}" cannot be a vertex/edge`, '$.root');
    }
  }
  for (const cell of contentCells) {
    if (cell.parent === null) reject(`cell "${cell.id}" is missing a parent`, '$.root');
    if (!layerIds.has(cell.parent)) {
      rejectUnsupported(`cell "${cell.id}" is nested in non-layer cell "${cell.parent}"; groups are not supported`, '$.root');
    }
    if (cell.vertex && cell.edge) reject(`cell "${cell.id}" cannot be both vertex and edge`, '$.root');
    if (!cell.vertex && !cell.edge) rejectUnsupported(`cell "${cell.id}" has no vertex/edge role`, '$.root');
    if (cell.edge) {
      if (cell.source === null || cell.target === null) reject(`edge cell "${cell.id}" requires source and target`, '$.root');
      const sourceCell = byId.get(cell.source);
      const targetCell = byId.get(cell.target);
      if (!sourceCell || !targetCell) reject(`edge cell "${cell.id}" references a missing endpoint`, '$.root');
      for (const [side, endpoint] of [['source', sourceCell], ['target', targetCell]]) {
        if (!endpoint.vertex) reject(`edge cell "${cell.id}" ${side} must reference a vertex cell`, '$.root');
      }
    }
    if (cell.vertex && (cell.source !== null || cell.target !== null)) {
      reject(`vertex cell "${cell.id}" cannot have source/target attributes`, '$.root');
    }
  }

  return {
    cells,
    layers: layerCells.map((layer) => ({ id: layer.id, value: layer.value })),
  };
}

/**
 * @param {XmlNode} diagramNode
 * @returns {XmlNode}
 */
function readDiagram(diagramNode) {
  validateAttributes(diagramNode, DIAGRAM_ATTRS);
  const children = diagramNode.children.filter((child) => Array.isArray(child.children));
  if (children.length === 0) {
    if (diagramNode.text.trim() !== '') {
      rejectUnsupported(
        'compressed diagram content is not supported; export the diagram as uncompressed XML first',
        '$.diagram',
      );
    }
    reject('diagram element is empty', '$.diagram');
  }
  if (children.length > 1) rejectUnsupported('multi-page diagrams are not supported', '$.diagram');
  if (children[0].name !== 'mxGraphModel') {
    rejectUnsupported(`unknown diagram child <${children[0].name}>`, '$.diagram');
  }
  return children[0];
}

/* -------------------------------------------------------------------------- */
/* canonical semantic form                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Canonical style string: entries sorted by key, bare tokens preserved.
 * @param {unknown} style
 * @returns {string}
 */
function canonicalStyle(style) {
  /** @type {Array<[string, string]>} */
  const entries = [];
  if (typeof style === 'string') {
    for (const part of style.split(';')) {
      if (part === '') continue;
      const eq = part.indexOf('=');
      if (eq === -1) entries.push([part, '']);
      else entries.push([part.slice(0, eq), part.slice(eq + 1)]);
    }
  } else if (isRecord(style)) {
    for (const key of Object.keys(style)) {
      const value = style[key];
      entries.push([key, value === undefined || value === null ? '' : String(value)]);
    }
  }
  entries.sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
  return entries.map(([key, value]) => (value === '' ? key : `${key}=${value}`)).join(';');
}

/** @param {unknown} value */
function canonicalVisible(value) {
  if (value === undefined || value === null) return true;
  if (value === false || value === '0' || value === 0) return false;
  return true;
}

/** @param {unknown} value */
function canonicalNumberOrNull(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value !== '' && Number.isFinite(Number(value))) return Number(value);
  return null;
}

/**
 * @param {any} cell
 * @returns {any}
 */
function canonicalCell(cell) {
  const data = isRecord(cell.data) ? cell.data : {};
  const pick = (flatName, shortName) => {
    if (cell[flatName] !== undefined) return cell[flatName];
    if (data[shortName] !== undefined) return data[shortName];
    return null;
  };
  let geometry = null;
  if (isRecord(cell.geometry)) {
    const rawPoints = Array.isArray(cell.geometry.points) ? cell.geometry.points : [];
    geometry = {
      x: canonicalNumberOrNull(cell.geometry.x),
      y: canonicalNumberOrNull(cell.geometry.y),
      width: canonicalNumberOrNull(cell.geometry.width),
      height: canonicalNumberOrNull(cell.geometry.height),
      relative: cell.geometry.relative === true || cell.geometry.relative === '1' ? true : null,
      as: cell.geometry.as ?? 'geometry',
      points: rawPoints.map((point) => ({
        x: canonicalNumberOrNull(point?.x),
        y: canonicalNumberOrNull(point?.y),
        as: point?.as ?? null,
      })),
    };
  }
  return {
    id: String(cell.id),
    parent: cell.parent ?? null,
    value: cell.value ?? '',
    style: canonicalStyle(cell.style),
    vertex: Boolean(cell.vertex),
    edge: Boolean(cell.edge),
    source: cell.source ?? null,
    target: cell.target ?? null,
    visible: canonicalVisible(cell.visible),
    data: {
      origin: pick('data_origin', 'origin'),
      certainty: pick('data_certainty', 'certainty'),
      base_digest: pick('data_base_digest', 'base_digest'),
      diagram_id: pick('data_diagram_id', 'diagram_id'),
      cell_kind: pick('data_cell_kind', 'cell_kind'),
    },
    geometry,
  };
}

/**
 * @param {{root_cells?: any[], layers?: any[], cells?: any[]}} model
 * @returns {any[]}
 */
function modelCells(model) {
  if (Array.isArray(model.cells)) return model.cells;
  if (!Array.isArray(model.root_cells)) {
    throw new DiagramError('INVALID_INPUT', 'canonicalMxGraph needs {cells} or {root_cells} or XML text');
  }
  const layers = Array.isArray(model.layers) ? model.layers : [];
  const layerIds = new Set(layers.map((layer) => String(layer?.id)));
  const cells = [];
  const cell0 = model.root_cells.find((cell) => String(cell?.id) === '0');
  if (cell0) cells.push(cell0);
  for (const layer of layers) {
    cells.push({ id: String(layer.id), parent: '0', value: layer.value, visible: layer.visible });
  }
  for (const cell of model.root_cells) {
    const id = String(cell?.id);
    if (id === '0' || layerIds.has(id)) continue;
    cells.push(cell);
  }
  return cells;
}

/**
 * Canonical semantic form for comparing two drawio representations. Ordering,
 * attribute order and style entry order are irrelevant; cells are sorted by id,
 * numbers and visibility flags are normalized. This is what the save guard uses
 * to compare client XML with the canonical XML (DIA-DESIGN-2 §9).
 *
 * Accepts a parsed document ({cells,layers}), an export model
 * ({root_cells,layers}) or raw XML text.
 *
 * @param {string | Uint8Array | {cells?: any[], root_cells?: any[], layers?: any[]}} model
 * @returns {string}
 */
function canonicalMxGraph(model) {
  /** @type {any[]} */
  let cells;
  if (typeof model === 'string' || model instanceof Uint8Array) {
    const parsed = parseDrawioXml(model);
    if (!parsed.ok) {
      throw new DiagramError(parsed.code, 'cannot canonicalize invalid drawio XML', { errors: parsed.errors });
    }
    cells = parsed.document.cells;
  } else if (isRecord(model)) {
    cells = modelCells(model);
  } else {
    throw new DiagramError('INVALID_INPUT', 'canonicalMxGraph needs XML text or a parsed/model document');
  }
  const normalized = cells
    .map((cell) => canonicalCell(cell))
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  return canonicalJson({ cells: normalized });
}

/* -------------------------------------------------------------------------- */
/* export: DiagramSpec + AnnotationOverlay -> restricted .drawio               */
/* -------------------------------------------------------------------------- */

const LAYERS = Object.freeze([
  { id: 'layer-base', value: 'Base' },
  { id: 'layer-annotations', value: 'Annotations' },
  { id: 'layer-notes', value: 'Notes' },
]);

const NODE_STYLES = Object.freeze({
  module: 'rounded=1;whiteSpace=wrap;fillColor=#dae8fc;strokeColor=#6c8ebf;fontSize=12;',
  function: 'rounded=1;whiteSpace=wrap;fillColor=#d5e8d4;strokeColor=#82b366;fontSize=12;',
  type: 'rounded=0;whiteSpace=wrap;fillColor=#fff2cc;strokeColor=#d6b656;fontSize=12;',
  resource: 'shape=cylinder;whiteSpace=wrap;fillColor=#f8cecc;strokeColor=#b85450;fontSize=12;',
  note: 'shape=note;whiteSpace=wrap;fillColor=#ffffff;strokeColor=#999999;fontSize=12;',
});
const BASE_EDGE_STYLE = 'edgeStyle=orthogonalEdgeStyle;rounded=0;strokeColor=#666666;fontSize=11;';
const ANNOTATION_NODE_STYLE = 'rounded=1;whiteSpace=wrap;fillColor=#e1d5e7;strokeColor=#9673a6;fontSize=12;';
const ANNOTATION_EDGE_STYLE = 'edgeStyle=orthogonalEdgeStyle;rounded=0;dashed=1;strokeColor=#9673a6;fontSize=11;';
const NOTE_STYLE = 'shape=note;whiteSpace=wrap;fillColor=#fff2cc;strokeColor=#d6b656;fontSize=12;';

const DEFAULT_NODE_SIZE = Object.freeze({ width: 160, height: 64 });

/** @param {any} left @param {any} right */
function byId(left, right) {
  const leftId = String(left?.id ?? '');
  const rightId = String(right?.id ?? '');
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}

/** @param {string} value @param {string} what @param {string} code */
function assertPlainDisplayText(value, what, code) {
  if (typeof value !== 'string') throw new DiagramError(code, `${what} must be a string`);
  if (looksLikeMarkup(value)) {
    throw new DiagramError(code, `${what} contains HTML/script markup and cannot be written to drawio`, {
      errors: [issue('$.value', 'forbiddenValue', `${what} contains HTML/script markup`)],
    });
  }
  if ([...value].some((ch) => {
    const cp = ch.codePointAt(0);
    return !isLegalXmlCodePoint(cp ?? 0);
  })) {
    throw new DiagramError(code, `${what} contains characters that are not legal XML`, {
      errors: [issue('$.value', 'invalidChar', `${what} contains an illegal XML character`)],
    });
  }
}

/** @param {any} position @param {any} fallback */
function exportPosition(position, fallback = DEFAULT_NODE_SIZE) {
  const x = Number.isSafeInteger(position?.x) ? position.x : 0;
  const y = Number.isSafeInteger(position?.y) ? position.y : 0;
  const width = Number.isSafeInteger(position?.width) && position.width >= 1 ? position.width : fallback.width;
  const height = Number.isSafeInteger(position?.height) && position.height >= 1 ? position.height : fallback.height;
  return { x, y, width, height };
}

/**
 * Export a validated DiagramSpecV1 + AnnotationOverlayV1 to the restricted
 * `.drawio` profile.
 *
 * @param {{spec: any, annotation_overlay?: any, overlay?: any}} input
 * @param {{now?: string, diagram_name?: string, limits?: Record<string, number>, self_check?: boolean}} [policy]
 * @returns {{xml: string, warnings: string[]}}
 */
function exportDrawio(input, policy = {}) {
  if (!isRecord(input) || !isRecord(input.spec)) {
    throw new DiagramError('INVALID_INPUT', 'exportDrawio expects {spec, annotation_overlay}');
  }
  const spec = input.spec;
  const contracts = requireContracts();
  const specCheck = contracts.validateDiagramSpec(spec);
  if (!specCheck.ok) {
    throw new DiagramError('INVALID_SPEC', 'diagram spec failed validation', { errors: specCheck.errors });
  }
  const specDigest = contracts.specDigest(spec);
  const now = typeof policy.now === 'string' ? policy.now : new Date().toISOString();
  const providedOverlay = input.annotation_overlay ?? input.overlay ?? null;
  const overlay =
    providedOverlay ??
    {
      schema_version: 1,
      diagram_id: spec.diagram_id,
      base_spec_digest: specDigest,
      revision: 0,
      items: [],
      orphaned_annotations: [],
      updated_at: now,
    };
  const overlayCheck = contracts.validateOverlay(overlay);
  if (!overlayCheck.ok) {
    throw new DiagramError('INVALID_OVERLAY', 'annotation overlay failed validation', { errors: overlayCheck.errors });
  }
  if (typeof contracts.validateComposite === 'function') {
    const composite = contracts.validateComposite(spec, overlay);
    if (composite && composite.ok === false) {
      throw new DiagramError('INVALID_OVERLAY', 'spec/overlay do not form a valid composite', {
        errors: composite.errors,
      });
    }
  }

  /** @type {string[]} */
  const warnings = [];
  const specLayout = new Map();
  for (const position of spec.layout?.positions ?? []) {
    if (isRecord(position) && typeof position.node_id === 'string') specLayout.set(position.node_id, position);
  }
  /** @type {Map<string, any>} */
  const layoutOverrides = new Map();
  /** @type {Set<string>} */
  const hidden = new Set();
  const items = Array.isArray(overlay.items) ? overlay.items : [];
  for (const item of items) {
    if (!isRecord(item)) continue;
    if (item.kind === 'layout' && typeof item.target_ref === 'string') layoutOverrides.set(item.target_ref, item.position);
    else if (item.kind === 'visibility' && item.hidden === true && typeof item.target_ref === 'string') {
      hidden.add(item.target_ref);
    }
  }
  if (Array.isArray(overlay.orphaned_annotations) && overlay.orphaned_annotations.length > 0) {
    warnings.push('orphaned_annotations_not_serialized');
  }

  const baseNodeIds = new Set((spec.nodes ?? []).map((node) => node.id));
  const annotationNodeIds = new Set(
    items.filter((item) => item.kind === 'annotation_node').map((item) => item.id),
  );
  /** @param {string} ref @returns {string | null} */
  const cellRef = (ref) => {
    if (baseNodeIds.has(ref)) return `base:${ref}`;
    if (annotationNodeIds.has(ref)) return `overlay:${ref}`;
    return null;
  };

  /** @type {any[]} */
  const cells = [];

  const nodes = [...(spec.nodes ?? [])].sort(byId);
  for (const node of nodes) {
    assertPlainDisplayText(node.label, `node "${node.id}" label`, 'INVALID_SPEC');
    const position = exportPosition(layoutOverrides.get(node.id) ?? specLayout.get(node.id));
    /** @type {any} */
    const cell = {
      id: `base:${node.id}`,
      parent: 'layer-base',
      value: node.label,
      style: NODE_STYLES[node.kind] ?? NODE_STYLES.module,
      vertex: true,
      data_cell_kind: 'base_node',
      geometry: { ...position, as: 'geometry' },
    };
    if (hidden.has(node.id)) cell.visible = false;
    cells.push(cell);
  }

  const baseEdges = [...(spec.edges ?? [])].sort(byId);
  for (const edge of baseEdges) {
    assertPlainDisplayText(edge.label ?? '', `edge "${edge.id}" label`, 'INVALID_SPEC');
    const source = cellRef(edge.from);
    const target = cellRef(edge.to);
    if (source === null || target === null) {
      throw new DiagramError('INVALID_SPEC', `base edge "${edge.id}" references a node outside the spec`);
    }
    /** @type {any} */
    const cell = {
      id: `base:${edge.id}`,
      parent: 'layer-base',
      value: edge.label ?? '',
      style: BASE_EDGE_STYLE,
      edge: true,
      source,
      target,
      data_cell_kind: 'base_edge',
    };
    // A base edge connected to a hidden base node is hidden in the view only:
    // the base spec is untouched and the evidence remains in the JSON pack.
    if (hidden.has(edge.id) || hidden.has(edge.from) || hidden.has(edge.to)) cell.visible = false;
    cells.push(cell);
  }

  const annotationNodes = items.filter((item) => item.kind === 'annotation_node').sort(byId);
  for (const item of annotationNodes) {
    assertPlainDisplayText(item.label, `annotation node "${item.id}" label`, 'INVALID_OVERLAY');
    cells.push({
      id: `overlay:${item.id}`,
      parent: 'layer-annotations',
      value: item.label,
      style: ANNOTATION_NODE_STYLE,
      vertex: true,
      data_origin: 'annotation',
      data_certainty: 'unknown',
      data_cell_kind: 'annotation_node',
      geometry: { ...exportPosition(item.position), as: 'geometry' },
    });
  }

  const annotationEdges = items.filter((item) => item.kind === 'annotation_edge').sort(byId);
  for (const item of annotationEdges) {
    assertPlainDisplayText(item.label ?? '', `annotation edge "${item.id}" label`, 'INVALID_OVERLAY');
    const source = cellRef(item.from);
    const target = cellRef(item.to);
    if (source === null || target === null) {
      throw new DiagramError('INVALID_OVERLAY', `annotation edge "${item.id}" references an unknown endpoint`);
    }
    cells.push({
      id: `overlay:${item.id}`,
      parent: 'layer-annotations',
      value: item.label ?? '',
      style: ANNOTATION_EDGE_STYLE,
      edge: true,
      source,
      target,
      data_origin: 'annotation',
      data_certainty: 'unknown',
      data_cell_kind: 'annotation_edge',
    });
  }

  const notes = items.filter((item) => item.kind === 'note').sort(byId);
  for (const item of notes) {
    assertPlainDisplayText(item.text, `note "${item.id}" text`, 'INVALID_OVERLAY');
    cells.push({
      id: `overlay:${item.id}`,
      parent: 'layer-notes',
      value: item.text,
      style: NOTE_STYLE,
      vertex: true,
      data_origin: 'annotation',
      data_certainty: 'unknown',
      data_cell_kind: 'note',
      geometry: { ...exportPosition(item.position), as: 'geometry' },
    });
  }
  if (notes.some((item) => item.target_ref !== null && item.target_ref !== undefined)) {
    // The restricted .drawio profile is not the authoritative overlay store:
    // note target references stay in annotations.json and are not trusted from
    // XML (DIA-DESIGN-2 §7).
    warnings.push('note_target_ref_not_serialized');
  }

  const digest = specDigest;
  const model = {
    root_cells: [
      {
        id: '0',
        data_diagram_id: spec.diagram_id,
        data_base_digest: digest,
      },
      ...cells,
    ],
    layers: LAYERS,
  };
  const modelXml = serializeMxGraphModel(model);
  const diagramName = policy.diagram_name ?? spec.title ?? 'diagram';
  const xml = `<mxfile host="local-diagrams" version="v1">\n<diagram id="${escXmlAttr(spec.diagram_id)}" name="${escXmlAttr(diagramName)}">\n${modelXml}\n</diagram>\n</mxfile>`;
  const bytes = utf8Length(xml);
  const maxBytes = Number.isSafeInteger(policy.limits?.document_xml_bytes)
    ? policy.limits.document_xml_bytes
    : LIMITS.document_xml_bytes;
  if (bytes > maxBytes) {
    throw new DiagramError('LIMIT_EXCEEDED', `serialized drawio XML is ${bytes} bytes; limit is ${maxBytes}`);
  }

  if (policy.self_check !== false) {
    const reparsed = parseDrawioXml(xml);
    if (!reparsed.ok) {
      throw new DiagramError('INTERNAL_FAILURE', 'serialized drawio XML failed the restricted parser self-check', {
        errors: reparsed.errors,
      });
    }
    if (canonicalMxGraph(model) !== canonicalMxGraph(reparsed.document)) {
      throw new DiagramError('INTERNAL_FAILURE', 'serialized drawio XML is not semantically stable across a round-trip');
    }
  }

  return { xml, warnings };
}

exports.parseXmlRestricted = parseXmlRestricted;
exports.serializeMxGraphModel = serializeMxGraphModel;
exports.parseDrawioXml = parseDrawioXml;
exports.canonicalMxGraph = canonicalMxGraph;
exports.exportDrawio = exportDrawio;
		};
		__definitions["src/editor/model.mjs"] = function (module, exports, __require) {
/**
 * Editor model, command union, history and overlay rebase (DIA-07 / DIA-API-EDIT).
 *
 * Frozen behaviour (docs/software-design.md §7, docs/interfaces.md §7):
 *  - `EditorModelV1` is immutable: every successful command returns a new
 *    model; the caller's previous model is never mutated.
 *  - the base DiagramSpecV1 is held internally (non-enumerable) and is never
 *    mutated; only the AnnotationOverlayV1 changes.
 *  - the command union is exactly the ten kinds from the design. Payload shape
 *    is validated by `src/contracts.mjs` (`validateEditorCommand`, closed
 *    objects); this module adds semantic validation (entity existence,
 *    visibility, endpoint validity, mode rules, limits).
 *  - `command_id` dedupe: same id + same content is idempotent (no extra
 *    revision); same id + different content is a conflict.
 *  - successful edits advance `draft_revision` monotonically. `undo`/`redo`
 *    never decrease it; they replay an internally stored composite patch.
 *  - a `remove_annotation_node` plus all associated edges/notes/layout/
 *    visibility items is one composite history entry.
 *  - history is capped at 100 entries / 2 MiB (oldest complete command is
 *    evicted first); new edits clear the redo stack.
 *  - `undo`/`redo` validate the current revision and the full overlay before
 *    they are applied; invalid replays are refused without touching state.
 *  - inverse patches are returned for internal callers only; they are not an
 *    RPC payload.
 */

const { LIMITS } = __require("src/limits.mjs");
const { DiagramError } = __require("src/errors.mjs");
const { canonicalJson, digestOf, sha256Hex, utf8Length } = __require("src/canonical.mjs");

/* -------------------------------------------------------------------------- */
/* contracts seam (same pattern as src/drawio/xml.mjs)                         */
/* -------------------------------------------------------------------------- */

let CONTRACTS = null;
try {
  CONTRACTS = __require("src/contracts.mjs");
} catch (error) {
  if (!(error && /** @type {any} */ (error).code === 'ERR_MODULE_NOT_FOUND')) throw error;
}

/** @returns {any} */
function requireContracts() {
  if (!CONTRACTS) {
    throw new DiagramError('INVALID_INPUT', 'shared contracts module (src/contracts.mjs) is not available');
  }
  return CONTRACTS;
}

/* -------------------------------------------------------------------------- */
/* internals                                                                   */
/* -------------------------------------------------------------------------- */

const BASE_SPEC = Symbol('local-diagrams.baseSpec');
const HISTORY = Symbol('local-diagrams.history');
const REDO_STACK = Symbol('local-diagrams.redoStack');
const COMMANDS = Symbol('local-diagrams.commands');

const DEFAULT_NODE_SIZE = Object.freeze({ width: 160, height: 64 });
const COMMAND_MAX_KINDS = 1024;
const REDO_STACK_LIMIT = 100;

/** @param {unknown} value @returns {value is Record<string, any>} */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {Record<string, any> | null}
 */
function asRecord(value) {
  return isRecord(value) ? value : null;
}

/** @param {unknown} value */
function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

/** @param {any} value */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  if (Array.isArray(value)) {
    for (const entry of value) deepFreeze(entry);
  } else {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} path
 * @returns {Array<{path: string, keyword: string, message: string}>}
 */
function issue(value, path = '$') {
  return [{ path, keyword: 'invalid_command', message: String(value) }];
}

/** @param {string} message @param {string} [path] @returns {never} */
function invalidCommand(message, path = '$') {
  throw new DiagramError('INVALID_COMMAND', message, { errors: issue(message, path) });
}

/** @param {string} message @param {string} [path] @returns {never} */
function limitExceeded(message, path = '$') {
  throw new DiagramError('LIMIT_EXCEEDED', message, { errors: [{ path, keyword: 'limit', message }] });
}

/** @param {Record<string, any>} [options] */
function resolveNow(options) {
  if (options && typeof options.now === 'string') return options.now;
  if (options && typeof options.clock === 'function') {
    const value = options.clock();
    if (typeof value === 'string') return value;
  }
  return new Date().toISOString();
}

/** @param {Record<string, any>} [options] */
function resolveHistoryLimits(options) {
  const custom = isRecord(options?.limits) ? options.limits : {};
  const entries =
    Number.isSafeInteger(custom.editor_history_entries) && custom.editor_history_entries >= 1
      ? custom.editor_history_entries
      : LIMITS.editor_history_entries;
  const bytes =
    Number.isSafeInteger(custom.editor_history_bytes) && custom.editor_history_bytes >= 1024
      ? custom.editor_history_bytes
      : LIMITS.editor_history_bytes;
  return { entries, bytes };
}

/* -------------------------------------------------------------------------- */
/* model construction                                                          */
/* -------------------------------------------------------------------------- */

/**
 * @param {any} baseSpec
 * @param {string} baseSpecDigest
 * @param {any} overlay
 * @param {string[]} selection
 * @param {number} draftRevision
 * @param {boolean} dirty
 * @param {{history?: any[], redoStack?: any[], commands?: Map<string, string>}} internals
 * @returns {any}
 */
function assembleModel(baseSpec, baseSpecDigest, overlay, selection, draftRevision, dirty, internals) {
  /** @type {any} */
  const model = {
    schema_version: 1,
    base_spec_digest: baseSpecDigest,
    overlay,
    selection,
    draft_revision: draftRevision,
    dirty,
  };
  Object.defineProperty(model, BASE_SPEC, { value: baseSpec, enumerable: false, writable: false });
  Object.defineProperty(model, HISTORY, { value: internals.history ?? [], enumerable: false, writable: false });
  Object.defineProperty(model, REDO_STACK, { value: internals.redoStack ?? [], enumerable: false, writable: false });
  Object.defineProperty(model, COMMANDS, { value: internals.commands ?? new Map(), enumerable: false, writable: false });
  return deepFreeze(model);
}

/** @param {unknown} model @returns {boolean} */
function isEditorModel(model) {
  return (
    isRecord(model) &&
    model[BASE_SPEC] !== undefined &&
    model.schema_version === 1 &&
    typeof model.base_spec_digest === 'string' &&
    isRecord(model.overlay) &&
    Array.isArray(model.selection) &&
    Number.isSafeInteger(model.draft_revision) &&
    typeof model.dirty === 'boolean'
  );
}

/** @param {any} model */
function baseSpecOf(model) {
  return model[BASE_SPEC];
}

/**
 * Build the edit model. The base spec and overlay are cloned and frozen so the
 * caller cannot mutate the document through the model.
 *
 * @param {any} spec DiagramSpecV1
 * @param {any} [overlay] AnnotationOverlayV1 (defaults to an empty overlay)
 * @param {{now?: string, clock?: () => string}} [options]
 * @returns {any} EditorModelV1
 */
function createEditorModel(spec, overlay, options = {}) {
  const contracts = requireContracts();
  const specResult = contracts.validateDiagramSpec(spec);
  if (!specResult.ok) {
    throw new DiagramError('INVALID_SPEC', 'cannot create editor model: invalid diagram spec', {
      errors: specResult.errors,
    });
  }
  const baseSpecDigest = contracts.specDigest(spec);
  let overlayValue;
  if (overlay === undefined || overlay === null) {
    overlayValue = contracts.emptyOverlay({
      diagram_id: spec.diagram_id,
      base_spec_digest: baseSpecDigest,
      now: resolveNow(options),
    });
  } else {
    const composite = contracts.validateComposite(spec, overlay);
    if (!composite.ok) {
      throw new DiagramError('INVALID_OVERLAY', 'cannot create editor model: invalid annotation overlay', {
        errors: composite.errors,
      });
    }
    overlayValue = overlay;
  }
  if (!Number.isSafeInteger(overlayValue.revision) || overlayValue.revision < 0) {
    throw new DiagramError('INVALID_OVERLAY', 'overlay revision must be a non-negative safe integer');
  }
  const baseSpec = deepFreeze(clone(spec));
  const overlayClone = deepFreeze(clone(overlayValue));
  const selection = [];
  const model = assembleModel(baseSpec, baseSpecDigest, overlayClone, selection, overlayValue.revision, false, {});
  const modelResult = contracts.validateEditorModel(model);
  if (!modelResult.ok) {
    throw new DiagramError('INVALID_EDITOR_MODEL', 'constructed editor model is invalid', {
      errors: modelResult.errors,
    });
  }
  return model;
}

/* -------------------------------------------------------------------------- */
/* entity helpers                                                              */
/* -------------------------------------------------------------------------- */

/** @param {any} baseSpec */
function baseNodeIds(baseSpec) {
  return new Set((baseSpec.nodes ?? []).map((node) => node.id));
}

/** @param {any} baseSpec */
function baseEdgeIds(baseSpec) {
  return new Set((baseSpec.edges ?? []).map((edge) => edge.id));
}

/** @param {any} baseSpec */
function baseEntityIds(baseSpec) {
  return new Set([...baseNodeIds(baseSpec), ...baseEdgeIds(baseSpec)]);
}

/** @param {{overlay: any}} model @param {string} targetRef */
function visibilityItem(model, targetRef) {
  return model.overlay.items.find((item) => item.kind === 'visibility' && item.target_ref === targetRef) ?? null;
}

/** @param {{overlay: any}} model @param {string} targetRef */
function isHidden(model, targetRef) {
  const item = visibilityItem(model, targetRef);
  return item !== null && item.hidden === true;
}

/** @param {any} model @param {string} id */
function itemById(model, id) {
  return model.overlay.items.find((item) => item.id === id) ?? null;
}

/** @param {any} model */
function annotationNodeIds(model) {
  return new Set(
    model.overlay.items.filter((item) => item.kind === 'annotation_node').map((item) => item.id),
  );
}

/** @param {any} model */
function visibleNodeIds(model) {
  const baseSpec = baseSpecOf(model);
  const ids = new Set();
  for (const nodeId of baseNodeIds(baseSpec)) {
    if (!isHidden(model, nodeId)) ids.add(nodeId);
  }
  for (const item of model.overlay.items) {
    if (item.kind === 'annotation_node') ids.add(item.id);
  }
  return ids;
}

/** @param {any} model */
function documentEntityIds(model) {
  const baseSpec = baseSpecOf(model);
  const ids = baseEntityIds(baseSpec);
  for (const item of model.overlay.items) {
    if (item.kind === 'annotation_node' || item.kind === 'annotation_edge') ids.add(item.id);
  }
  return ids;
}

/** @param {any} baseSpec @param {string} nodeId */
function specPosition(baseSpec, nodeId) {
  const position = (baseSpec.layout?.positions ?? []).find((entry) => entry.node_id === nodeId);
  return position ?? null;
}

/**
 * @param {any} baseSpec
 * @param {any} overlay
 * @param {string} nodeId
 * @param {any[]} items
 * @param {any} currentModel
 * @returns {{x: number, y: number, width: number, height: number}}
 */
function currentBaseNodePosition(currentModel, nodeId) {
  const baseSpec = baseSpecOf(currentModel);
  const layout = currentModel.overlay.items.find((item) => item.kind === 'layout' && item.target_ref === nodeId);
  const fromSpec = specPosition(baseSpec, nodeId);
  const source = layout?.position ?? fromSpec ?? DEFAULT_NODE_SIZE;
  return {
    x: Number.isSafeInteger(source.x) ? source.x : 0,
    y: Number.isSafeInteger(source.y) ? source.y : 0,
    width: Number.isSafeInteger(source.width) && source.width >= 1 ? source.width : DEFAULT_NODE_SIZE.width,
    height: Number.isSafeInteger(source.height) && source.height >= 1 ? source.height : DEFAULT_NODE_SIZE.height,
  };
}

/**
 * Deterministic overlay id for an internal layout/visibility item. The prefix
 * is not required by the overlay schema for layout/visibility, but using it
 * keeps every tool-owned item recognisable and collision-free.
 *
 * @param {any} model
 * @param {string} candidate
 * @returns {string}
 */
function uniqueOverlayItemId(model, candidate) {
  const taken = new Set(model.overlay.items.map((item) => item.id));
  const base = baseEntityIds(baseSpecOf(model));
  let id = candidate;
  let counter = 2;
  while (taken.has(id) || base.has(id)) {
    id = `${candidate}-${counter}`;
    counter += 1;
  }
  return id;
}

/* -------------------------------------------------------------------------- */
/* patch application                                                           */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {{before_revision: number, after_revision: number, restore_items: any[], remove_ids: string[], restore_selection: string[]}} Patch
 */

/**
 * Apply an internal composite patch to an overlay clone. The patch removes the
 * listed ids and re-adds the exact prior/new overlay items; the full overlay is
 * validated by the caller afterwards.
 *
 * @param {any} overlay
 * @param {Patch} patch
 * @param {number} revision
 * @param {string} now
 * @returns {any}
 */
function applyPatchToOverlay(overlay, patch, revision, now) {
  const removeIds = new Set(patch.remove_ids ?? []);
  const restoreItems = (patch.restore_items ?? []).map((item) => clone(item));
  const restoreIds = new Set(restoreItems.map((item) => item.id));
  const items = overlay.items.filter((item) => !removeIds.has(item.id) && !restoreIds.has(item.id));
  for (const item of restoreItems) items.push(item);
  return {
    ...overlay,
    revision,
    items,
    updated_at: now,
  };
}

/** @param {any} model @param {any} limit @returns {any[]} */
function trimHistory(history, limit) {
  const entries = [...history];
  let bytes = entries.reduce((sum, entry) => sum + (Number.isSafeInteger(entry.bytes) ? entry.bytes : 0), 0);
  while (entries.length > limit.entries || (bytes > limit.bytes && entries.length > 1)) {
    const removed = entries.shift();
    bytes -= Number.isSafeInteger(removed.bytes) ? removed.bytes : 0;
  }
  return entries;
}

/* -------------------------------------------------------------------------- */
/* command execution                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Execute one editor command against an immutable editor model.
 *
 * @param {any} model EditorModelV1
 * @param {{command_id: string, expected_draft_revision: number, kind: string, payload: any}} command
 * @param {{now?: string, clock?: () => string, limits?: Record<string, number>}} [options]
 * @returns {{status: 'ok', model: any, inverse: any, deduplicated?: boolean}
 *   | {status: 'stale' | 'invalid', code: string, errors?: Array<{path: string, keyword: string, message: string}>}}
 */
function executeEdit(model, command, options = {}) {
  const contracts = requireContracts();
  if (!isEditorModel(model)) {
    return {
      status: 'invalid',
      code: 'INVALID_EDITOR_MODEL',
      errors: issue('model is not an editor model created by createEditorModel'),
    };
  }
  const commandResult = contracts.validateEditorCommand(command);
  if (!commandResult.ok) {
    return { status: 'invalid', code: 'INVALID_COMMAND', errors: commandResult.errors };
  }
  const commandDigest = digestOf({ kind: command.kind, payload: command.payload });
  const seenCommands = model[COMMANDS];
  if (seenCommands.has(command.command_id)) {
    if (seenCommands.get(command.command_id) === commandDigest) {
      return { status: 'ok', model, inverse: null, deduplicated: true };
    }
    return {
      status: 'invalid',
      code: 'CONFLICT',
      errors: [{ path: '$.command_id', keyword: 'conflict', message: 'command_id was already used with different content' }],
    };
  }
  if (
    !Number.isSafeInteger(command.expected_draft_revision) ||
    command.expected_draft_revision !== model.draft_revision
  ) {
    return {
      status: 'stale',
      code: 'STALE_VERSION',
      errors: [
        {
          path: '$.expected_draft_revision',
          keyword: 'stale',
          message: `expected draft revision ${command.expected_draft_revision}, current is ${model.draft_revision}`,
        },
      ],
    };
  }

  const now = resolveNow(options);
  const historyLimits = resolveHistoryLimits(options);
  try {
    if (command.kind === 'undo') {
      return performUndo(model, command, now);
    }
    if (command.kind === 'redo') {
      return performRedo(model, command, now);
    }
    const outcome = runCommand(model, command);
    return commitCommand(model, command, outcome, commandDigest, now, historyLimits);
  } catch (error) {
    if (error instanceof DiagramError) {
      return {
        status: 'invalid',
        code: error.code,
        errors: error.details?.errors ?? issue(error.message),
      };
    }
    throw error;
  }
}

/**
 * @param {any} model
 * @param {any} command
 * @returns {{overlay: any, selection: string[], undo: {remove_ids: string[], restore_items: any[]}, redo: {remove_ids: string[], restore_items: any[]}}}
 */
function runCommand(model, command) {
  const overlay = structuredClone(model.overlay);
  const items = overlay.items;
  const selection = [...model.selection];
  const payload = command.payload;

  /**
   * @param {string} id
   * @returns {number}
   */
  const indexOf = (id) => items.findIndex((item) => item.id === id);

  switch (command.kind) {
    case 'move_node': {
      const nodeId = payload.node_id;
      const baseSpec = baseSpecOf(model);
      const baseNodeExists = (baseSpec.nodes ?? []).some((node) => node.id === nodeId);
      const index = indexOf(nodeId);
      const existing = index === -1 ? null : items[index];
      if (!baseNodeExists && !existing) invalidCommand(`node "${nodeId}" does not exist`, '$.payload.node_id');
      if (existing && existing.kind !== 'annotation_node') {
        invalidCommand(`"${nodeId}" is not a node`, '$.payload.node_id');
      }
      if (baseNodeExists && isHidden(model, nodeId)) {
        invalidCommand(`node "${nodeId}" is hidden`, '$.payload.node_id');
      }
      if (existing) {
        const updated = {
          ...existing,
          position: { x: payload.x, y: payload.y, width: existing.position.width, height: existing.position.height },
        };
        items[index] = updated;
        return {
          overlay,
          selection,
          undo: { remove_ids: [updated.id], restore_items: [existing] },
          redo: { remove_ids: [updated.id], restore_items: [updated] },
        };
      }
      const current = currentBaseNodePosition(model, nodeId);
      const position = { x: payload.x, y: payload.y, width: current.width, height: current.height };
      const layout = items.find((item) => item.kind === 'layout' && item.target_ref === nodeId);
      if (layout) {
        const updated = { ...layout, position };
        items[items.indexOf(layout)] = updated;
        return {
          overlay,
          selection,
          undo: { remove_ids: [updated.id], restore_items: [layout] },
          redo: { remove_ids: [updated.id], restore_items: [updated] },
        };
      }
      const id = uniqueOverlayItemId(model, `ann:layout-${sha256Hex(nodeId).slice(0, 16)}`);
      const item = { id, kind: 'layout', target_ref: nodeId, position };
      items.push(item);
      return {
        overlay,
        selection,
        undo: { remove_ids: [id], restore_items: [] },
        redo: { remove_ids: [], restore_items: [item] },
      };
    }
    case 'set_note': {
      const annotationId = payload.annotation_id;
      if (!annotationId.startsWith('ann:')) {
        invalidCommand('note ids must use the ann: prefix', '$.payload.annotation_id');
      }
      if (baseEntityIds(baseSpecOf(model)).has(annotationId)) {
        invalidCommand('note id collides with a base entity id', '$.payload.annotation_id');
      }
      const index = indexOf(annotationId);
      const existing = index === -1 ? null : items[index];
      if (existing && existing.kind !== 'note') {
        invalidCommand(`"${annotationId}" is not a note`, '$.payload.annotation_id');
      }
      if (payload.target_ref !== null && !documentEntityIds(model).has(payload.target_ref)) {
        invalidCommand(`note target "${payload.target_ref}" is not a document entity`, '$.payload.target_ref');
      }
      const item = {
        id: annotationId,
        kind: 'note',
        target_ref: payload.target_ref,
        text: payload.text,
        position: payload.position,
      };
      if (existing) items[index] = item;
      else items.push(item);
      return {
        overlay,
        selection,
        undo: existing
          ? { remove_ids: [item.id], restore_items: [existing] }
          : { remove_ids: [item.id], restore_items: [] },
        redo: { remove_ids: [item.id], restore_items: [item] },
      };
    }
    case 'add_annotation_node': {
      const baseSpec = baseSpecOf(model);
      if (baseSpec.mode !== 'conceptual') {
        invalidCommand('annotation nodes are only allowed in conceptual diagrams', '$.payload.id');
      }
      if (!payload.id.startsWith('ann:')) {
        invalidCommand('annotation node ids must use the ann: prefix', '$.payload.id');
      }
      if (baseEntityIds(baseSpec).has(payload.id) || indexOf(payload.id) !== -1) {
        invalidCommand(`id "${payload.id}" already exists`, '$.payload.id');
      }
      if (items.length + 1 > LIMITS.overlay_items) limitExceeded('overlay item limit exceeded', '$.payload.id');
      const item = {
        id: payload.id,
        kind: 'annotation_node',
        label: payload.label,
        description: payload.description,
        position: payload.position,
      };
      items.push(item);
      return {
        overlay,
        selection,
        undo: { remove_ids: [item.id], restore_items: [] },
        redo: { remove_ids: [], restore_items: [item] },
      };
    }
    case 'set_annotation_node': {
      const index = indexOf(payload.id);
      if (index === -1) invalidCommand(`annotation node "${payload.id}" does not exist`, '$.payload.id');
      const existing = items[index];
      if (existing.kind !== 'annotation_node') {
        invalidCommand(`"${payload.id}" is not an annotation node`, '$.payload.id');
      }
      const updated = { ...existing, label: payload.label, description: payload.description };
      items[index] = updated;
      return {
        overlay,
        selection,
        undo: { remove_ids: [updated.id], restore_items: [existing] },
        redo: { remove_ids: [updated.id], restore_items: [updated] },
      };
    }
    case 'add_annotation_edge': {
      if (!payload.id.startsWith('ann:')) {
        invalidCommand('annotation edge ids must use the ann: prefix', '$.payload.id');
      }
      if (baseEntityIds(baseSpecOf(model)).has(payload.id) || indexOf(payload.id) !== -1) {
        invalidCommand(`id "${payload.id}" already exists`, '$.payload.id');
      }
      const visible = visibleNodeIds(model);
      for (const endpoint of ['from', 'to']) {
        if (!visible.has(payload[endpoint])) {
          invalidCommand(`annotation edge ${endpoint} "${payload[endpoint]}" must be a visible node`, `$.payload.${endpoint}`);
        }
      }
      if (items.length + 1 > LIMITS.overlay_items) limitExceeded('overlay item limit exceeded', '$.payload.id');
      const annotationEdgeCount = items.filter((item) => item.kind === 'annotation_edge').length;
      if (annotationEdgeCount + 1 > LIMITS.annotation_edges) {
        limitExceeded('annotation edge limit exceeded', '$.payload.id');
      }
      const item = {
        id: payload.id,
        kind: 'annotation_edge',
        from: payload.from,
        to: payload.to,
        label: payload.label,
        description: payload.description,
      };
      items.push(item);
      return {
        overlay,
        selection,
        undo: { remove_ids: [item.id], restore_items: [] },
        redo: { remove_ids: [], restore_items: [item] },
      };
    }
    case 'remove_annotation': {
      const index = indexOf(payload.id);
      if (index === -1) invalidCommand(`overlay item "${payload.id}" does not exist`, '$.payload.id');
      const removed = items[index];
      if (removed.kind !== 'note' && removed.kind !== 'annotation_edge') {
        invalidCommand('remove_annotation only accepts note or annotation_edge items', '$.payload.id');
      }
      items.splice(index, 1);
      return {
        overlay,
        selection: selection.filter((id) => id !== removed.id),
        undo: { remove_ids: [], restore_items: [removed] },
        redo: { remove_ids: [removed.id], restore_items: [] },
      };
    }
    case 'remove_annotation_node': {
      return removeAnnotationNode(model, overlay, selection, payload);
    }
    case 'set_visibility': {
      const targetRef = payload.target_ref;
      if (!baseEntityIds(baseSpecOf(model)).has(targetRef)) {
        invalidCommand('visibility can only target base nodes or edges', '$.payload.target_ref');
      }
      const index = indexOf(visibilityItem(model, targetRef)?.id ?? '');
      const existing = index === -1 ? null : items[index];
      if (existing && existing.kind !== 'visibility') {
        invalidCommand(`"${targetRef}" does not have a visibility item`, '$.payload.target_ref');
      }
      const item = existing
        ? { ...existing, hidden: payload.hidden }
        : {
            id: uniqueOverlayItemId(model, `ann:visibility-${sha256Hex(targetRef).slice(0, 16)}`),
            kind: 'visibility',
            target_ref: targetRef,
            hidden: payload.hidden,
          };
      if (existing) items[index] = item;
      else items.push(item);
      return {
        overlay,
        selection,
        undo: existing
          ? { remove_ids: [item.id], restore_items: [existing] }
          : { remove_ids: [item.id], restore_items: [] },
        redo: { remove_ids: [item.id], restore_items: [item] },
      };
    }
    default:
      invalidCommand(`command kind "${command.kind}" is not supported`);
  }
  /* c8 ignore next */
  invalidCommand('unreachable');
}

/**
 * Composite removal of an annotation node.
 *
 * - overlay annotation node: the node plus all edges/notes/layout/visibility
 *   items that reference it are removed as one history entry.
 * - conceptual base annotation node: the base spec is untouched; a
 *   `visibility hidden` item is written after removing overlay items that
 *   reference the node (the evidence stays in the base, base edges are only
 *   hidden in the view).
 * - evidence base nodes/edges can never be physically removed.
 *
 * @param {any} model
 * @param {any} overlay
 * @param {string[]} selection
 * @param {any} payload
 * @returns {any}
 */
function removeAnnotationNode(model, overlay, selection, payload) {
  const nodeId = payload.node_id;
  const items = overlay.items;
  const baseSpec = baseSpecOf(model);
  const baseNode = (baseSpec.nodes ?? []).find((node) => node.id === nodeId) ?? null;
  const overlayNode = items.find((item) => item.id === nodeId) ?? null;
  if (!baseNode && !overlayNode) invalidCommand(`node "${nodeId}" does not exist`, '$.payload.node_id');
  if (overlayNode && overlayNode.kind !== 'annotation_node') {
    invalidCommand(`"${nodeId}" is not an annotation node`, '$.payload.node_id');
  }

  /** @type {Set<string>} */
  const associatedIds = new Set();
  for (const item of items) {
    if (item.id === nodeId) continue;
    if (item.kind === 'annotation_edge' && (item.from === nodeId || item.to === nodeId)) associatedIds.add(item.id);
    else if (item.kind === 'note' && item.target_ref === nodeId) associatedIds.add(item.id);
    else if (item.kind === 'layout' && item.target_ref === nodeId) associatedIds.add(item.id);
    else if (item.kind === 'visibility' && item.target_ref === nodeId) associatedIds.add(item.id);
  }

  /** @type {any[]} */
  const removedItems = [];
  /** @type {any[]} */
  const remaining = [];
  for (const item of items) {
    if (item.id === nodeId || associatedIds.has(item.id)) removedItems.push(item);
    else remaining.push(item);
  }
  const nextSelection = selection.filter((id) => id !== nodeId && !associatedIds.has(id));

  if (overlayNode) {
    items.length = 0;
    for (const item of remaining) items.push(item);
    return {
      overlay,
      selection: nextSelection,
      undo: { remove_ids: [], restore_items: clone(removedItems) },
      redo: { remove_ids: removedItems.map((item) => item.id), restore_items: [] },
    };
  }

  if (baseSpec.mode !== 'conceptual') {
    invalidCommand('evidence base nodes/edges cannot be removed; use set_visibility', '$.payload.node_id');
  }
  if (baseNode.origin !== 'annotation') {
    invalidCommand('only conceptual annotation-origin base nodes can be hidden', '$.payload.node_id');
  }
  if (isHidden(model, nodeId)) {
    invalidCommand(`node "${nodeId}" is already hidden`, '$.payload.node_id');
  }
  items.length = 0;
  for (const item of remaining) items.push(item);
  const baseIds = baseEntityIds(baseSpec);
  let visibilityId = `ann:visibility-${sha256Hex(nodeId).slice(0, 16)}`;
  let counter = 2;
  while (baseIds.has(visibilityId) || remaining.some((item) => item.id === visibilityId)) {
    visibilityId = `ann:visibility-${sha256Hex(nodeId).slice(0, 16)}-${counter}`;
    counter += 1;
  }
  const visibility = { id: visibilityId, kind: 'visibility', target_ref: nodeId, hidden: true };
  items.push(visibility);
  return {
    overlay,
    selection: nextSelection,
    undo: { remove_ids: [visibilityId], restore_items: clone(removedItems) },
    redo: { remove_ids: removedItems.map((item) => item.id), restore_items: [visibility] },
  };
}

/**
 * @param {any} model
 * @param {any} command
 * @param {{overlay: any, selection: string[], undo: {remove_ids: string[], restore_items: any[]}, redo: {remove_ids: string[], restore_items: any[]}}} outcome
 * @param {string} commandDigest
 * @param {string} now
 * @param {{entries: number, bytes: number}} historyLimits
 * @returns {any}
 */
function commitCommand(model, command, outcome, commandDigest, now, historyLimits) {
  const contracts = requireContracts();
  const baseSpec = baseSpecOf(model);
  const nextRevision = model.draft_revision + 1;
  if (!Number.isSafeInteger(nextRevision) || nextRevision > LIMITS.editor_draft_revision) {
    limitExceeded('draft revision limit exceeded', '$.draft_revision');
  }
  const nextOverlay = clone(outcome.overlay);
  nextOverlay.revision = nextRevision;
  nextOverlay.updated_at = now;
  const overlayResult = contracts.validateOverlay(nextOverlay);
  if (!overlayResult.ok) {
    throw new DiagramError('INVALID_OVERLAY', 'edit produced an invalid annotation overlay', {
      errors: overlayResult.errors,
    });
  }
  const composite = contracts.validateComposite(baseSpec, nextOverlay);
  if (!composite.ok) {
    throw new DiagramError('INVALID_OVERLAY', 'edit produced an invalid spec/overlay composite', {
      errors: composite.errors,
    });
  }
  /** @type {Patch} */
  const undoPatch = {
    before_revision: model.draft_revision,
    after_revision: nextRevision,
    restore_items: clone(outcome.undo.restore_items),
    remove_ids: [...outcome.undo.remove_ids],
    restore_selection: [...model.selection],
  };
  /** @type {Patch} */
  const redoPatch = {
    before_revision: model.draft_revision,
    after_revision: nextRevision,
    restore_items: clone(outcome.redo.restore_items),
    remove_ids: [...outcome.redo.remove_ids],
    restore_selection: [...outcome.selection],
  };
  const entry = {
    undo: undoPatch,
    redo: redoPatch,
    bytes: utf8Length(canonicalJson({ undo: undoPatch, redo: redoPatch })),
  };
  const history = trimHistory([...model[HISTORY], entry], historyLimits);
  const commands = new Map(model[COMMANDS]);
  commands.set(command.command_id, commandDigest);
  while (commands.size > COMMAND_MAX_KINDS) {
    const oldest = commands.keys().next().value;
    if (oldest === undefined) break;
    commands.delete(oldest);
  }
  const nextModel = assembleModel(
    baseSpec,
    model.base_spec_digest,
    deepFreeze(clone(nextOverlay)),
    [...outcome.selection],
    nextRevision,
    true,
    { history, redoStack: [], commands },
  );
  const modelResult = contracts.validateEditorModel(nextModel);
  if (!modelResult.ok) {
    throw new DiagramError('INVALID_EDITOR_MODEL', 'edit produced an invalid editor model', {
      errors: modelResult.errors,
    });
  }
  return { status: 'ok', model: nextModel, inverse: undoPatch };
}

/* -------------------------------------------------------------------------- */
/* undo / redo                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * @param {any} model
 * @param {any} command
 * @param {string} now
 * @returns {any}
 */
function performUndo(model, command, now) {
  const history = model[HISTORY];
  if (history.length === 0) invalidCommand('nothing to undo');
  const entry = history[history.length - 1];
  const nextRevision = model.draft_revision + 1;
  if (!Number.isSafeInteger(nextRevision) || nextRevision > LIMITS.editor_draft_revision) {
    limitExceeded('draft revision limit exceeded', '$.draft_revision');
  }
  const nextOverlay = applyPatchToOverlay(model.overlay, entry.undo, nextRevision, now);
  const contracts = requireContracts();
  const baseSpec = baseSpecOf(model);
  const overlayResult = contracts.validateOverlay(nextOverlay);
  if (!overlayResult.ok) {
    throw new DiagramError('INVALID_OVERLAY', 'undo produced an invalid annotation overlay', {
      errors: overlayResult.errors,
    });
  }
  const composite = contracts.validateComposite(baseSpec, nextOverlay);
  if (!composite.ok) {
    throw new DiagramError('INVALID_OVERLAY', 'undo produced an invalid spec/overlay composite', {
      errors: composite.errors,
    });
  }
  const nextHistory = history.slice(0, -1);
  const nextRedo = [...model[REDO_STACK], entry].slice(-REDO_STACK_LIMIT);
  const commands = new Map(model[COMMANDS]);
  commands.set(command.command_id, digestOf({ kind: command.kind, payload: command.payload }));
  const nextModel = assembleModel(
    baseSpec,
    model.base_spec_digest,
    deepFreeze(clone(nextOverlay)),
    entry.undo.restore_selection.map((id) => id),
    nextRevision,
    true,
    { history: nextHistory, redoStack: nextRedo, commands },
  );
  const modelResult = contracts.validateEditorModel(nextModel);
  if (!modelResult.ok) {
    throw new DiagramError('INVALID_EDITOR_MODEL', 'undo produced an invalid editor model', {
      errors: modelResult.errors,
    });
  }
  return { status: 'ok', model: nextModel, inverse: clone(entry.redo) };
}

/**
 * @param {any} model
 * @param {any} command
 * @param {string} now
 * @returns {any}
 */
function performRedo(model, command, now) {
  const redoStack = model[REDO_STACK];
  if (redoStack.length === 0) invalidCommand('nothing to redo');
  const entry = redoStack[redoStack.length - 1];
  const nextRevision = model.draft_revision + 1;
  if (!Number.isSafeInteger(nextRevision) || nextRevision > LIMITS.editor_draft_revision) {
    limitExceeded('draft revision limit exceeded', '$.draft_revision');
  }
  const nextOverlay = applyPatchToOverlay(model.overlay, entry.redo, nextRevision, now);
  const contracts = requireContracts();
  const baseSpec = baseSpecOf(model);
  const overlayResult = contracts.validateOverlay(nextOverlay);
  if (!overlayResult.ok) {
    throw new DiagramError('INVALID_OVERLAY', 'redo produced an invalid annotation overlay', {
      errors: overlayResult.errors,
    });
  }
  const composite = contracts.validateComposite(baseSpec, nextOverlay);
  if (!composite.ok) {
    throw new DiagramError('INVALID_OVERLAY', 'redo produced an invalid spec/overlay composite', {
      errors: composite.errors,
    });
  }
  const nextHistory = trimHistory([...model[HISTORY], entry], {
    entries: LIMITS.editor_history_entries,
    bytes: LIMITS.editor_history_bytes,
  });
  const nextRedo = redoStack.slice(0, -1);
  const commands = new Map(model[COMMANDS]);
  commands.set(command.command_id, digestOf({ kind: command.kind, payload: command.payload }));
  const nextModel = assembleModel(
    baseSpec,
    model.base_spec_digest,
    deepFreeze(clone(nextOverlay)),
    entry.redo.restore_selection.map((id) => id),
    nextRevision,
    true,
    { history: nextHistory, redoStack: nextRedo, commands },
  );
  const modelResult = contracts.validateEditorModel(nextModel);
  if (!modelResult.ok) {
    throw new DiagramError('INVALID_EDITOR_MODEL', 'redo produced an invalid editor model', {
      errors: modelResult.errors,
    });
  }
  return { status: 'ok', model: nextModel, inverse: clone(entry.undo) };
}

/* -------------------------------------------------------------------------- */
/* standalone undo/redo and serialization                                      */
/* -------------------------------------------------------------------------- */

/**
 * @param {any} model
 * @param {{now?: string, clock?: () => string}} [options]
 * @returns {any}
 */
function undo(model, options = {}) {
  if (!isEditorModel(model)) {
    return { status: 'invalid', code: 'INVALID_EDITOR_MODEL', errors: issue('model is not an editor model') };
  }
  try {
    return performUndo(model, { command_id: `internal:undo:${model.draft_revision}`, kind: 'undo', payload: {} }, resolveNow(options));
  } catch (error) {
    if (error instanceof DiagramError) {
      return {
        status: 'invalid',
        code: error.code,
        errors: error.details?.errors ?? issue(error.message),
      };
    }
    throw error;
  }
}

/**
 * @param {any} model
 * @param {{now?: string, clock?: () => string}} [options]
 * @returns {any}
 */
function redo(model, options = {}) {
  if (!isEditorModel(model)) {
    return { status: 'invalid', code: 'INVALID_EDITOR_MODEL', errors: issue('model is not an editor model') };
  }
  try {
    return performRedo(model, { command_id: `internal:redo:${model.draft_revision}`, kind: 'redo', payload: {} }, resolveNow(options));
  } catch (error) {
    if (error instanceof DiagramError) {
      return {
        status: 'invalid',
        code: error.code,
        errors: error.details?.errors ?? issue(error.message),
      };
    }
    throw error;
  }
}

/**
 * Deterministic serialization of the public `EditorModelV1` fields
 * (internals are non-enumerable and therefore excluded by construction).
 *
 * @param {any} model
 * @returns {string}
 */
function serializeEditorModel(model) {
  const contracts = requireContracts();
  if (!isEditorModel(model)) {
    throw new DiagramError('INVALID_EDITOR_MODEL', 'cannot serialize a model that is not an editor model');
  }
  const plain = {
    schema_version: 1,
    base_spec_digest: model.base_spec_digest,
    overlay: clone(model.overlay),
    selection: [...model.selection],
    draft_revision: model.draft_revision,
    dirty: model.dirty,
  };
  const result = contracts.validateEditorModel(plain);
  if (!result.ok) {
    throw new DiagramError('INVALID_EDITOR_MODEL', 'editor model failed validation before serialization', {
      errors: result.errors,
    });
  }
  return canonicalJson(plain);
}

/* -------------------------------------------------------------------------- */
/* rebase                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Rebind an existing overlay to a regenerated base spec by stable ID.
 *
 * Items whose target/endpoint disappeared are preserved in
 * `orphaned_annotations` (never silently dropped, never rebound to a
 * same-labelled entity). The base spec is not mutated.
 *
 * @param {any} spec New DiagramSpecV1
 * @param {any} overlay Existing AnnotationOverlayV1
 * @param {{now?: string, clock?: () => string}} [options]
 * @returns {{overlay: any, orphaned: any[]}}
 */
function rebaseOverlay(spec, overlay, options = {}) {
  const contracts = requireContracts();
  const specResult = contracts.validateDiagramSpec(spec);
  if (!specResult.ok) {
    throw new DiagramError('INVALID_SPEC', 'rebaseOverlay: invalid diagram spec', { errors: specResult.errors });
  }
  const overlayResult = contracts.validateOverlay(overlay);
  if (!overlayResult.ok) {
    throw new DiagramError('INVALID_OVERLAY', 'rebaseOverlay: invalid annotation overlay', {
      errors: overlayResult.errors,
    });
  }
  const now = resolveNow(options);
  const nodeIds = baseNodeIds(spec);
  const edgeIds = baseEdgeIds(spec);
  const entityIds = new Set([...nodeIds, ...edgeIds]);
  const mode = spec.mode;

  const annotationNodes = new Set(
    overlay.items.filter((item) => item.kind === 'annotation_node').map((item) => item.id),
  );
  const keptAnnotationNodes = new Set(mode === 'conceptual' ? [...annotationNodes] : []);

  const keptVisibility = new Map();
  const hiddenTargets = new Set();
  const orphanedNew = [];
  const keep = new Set();

  /** @param {any} item @param {'target_missing' | 'endpoint_missing'} reason */
  const orphan = (item, reason) => {
    orphanedNew.push({ item: clone(item), reason });
  };

  // Pass 1: annotation nodes (only valid in conceptual mode) and visibility.
  for (const item of overlay.items) {
    if (item.kind === 'annotation_node') {
      if (keptAnnotationNodes.has(item.id)) keep.add(item.id);
      else orphan(item, 'target_missing');
    } else if (item.kind === 'visibility') {
      if (entityIds.has(item.target_ref)) {
        keptVisibility.set(item.id, item);
        keep.add(item.id);
        if (item.hidden === true) hiddenTargets.add(item.target_ref);
      } else {
        orphan(item, 'target_missing');
      }
    }
  }
  const visibleNodes = new Set();
  for (const nodeId of nodeIds) if (!hiddenTargets.has(nodeId)) visibleNodes.add(nodeId);
  for (const nodeId of keptAnnotationNodes) visibleNodes.add(nodeId);

  // Pass 2: annotation edges need two visible nodes.
  const keptEdges = new Set();
  for (const item of overlay.items) {
    if (item.kind !== 'annotation_edge') continue;
    if (visibleNodes.has(item.from) && visibleNodes.has(item.to)) {
      keptEdges.add(item.id);
      keep.add(item.id);
    } else {
      orphan(item, 'endpoint_missing');
    }
  }

  // Pass 3: notes target an existing document entity; layout targets a base
  // node; anything else is orphaned (never rebound by label).
  const documentEntities = new Set([...entityIds, ...keptAnnotationNodes, ...keptEdges]);
  for (const item of overlay.items) {
    if (item.kind === 'note') {
      if (item.target_ref === null || documentEntities.has(item.target_ref)) keep.add(item.id);
      else orphan(item, 'target_missing');
    } else if (item.kind === 'layout') {
      if (nodeIds.has(item.target_ref)) keep.add(item.id);
      else orphan(item, 'target_missing');
    }
  }

  const keptItems = overlay.items.filter((item) => keep.has(item.id)).map((item) => clone(item));
  const existingOrphans = (overlay.orphaned_annotations ?? []).map((entry) => clone(entry));
  const orphaned = [...existingOrphans, ...orphanedNew];
  /** @type {any} */
  const nextOverlay = {
    schema_version: 1,
    diagram_id: spec.diagram_id,
    base_spec_digest: contracts.specDigest(spec),
    revision: overlay.revision,
    items: keptItems,
    orphaned_annotations: orphaned,
    updated_at: now,
  };
  if (orphaned.length > LIMITS.orphaned_annotations) {
    throw new DiagramError('LIMIT_EXCEEDED', `rebase produced ${orphaned.length} orphaned annotations; limit is ${LIMITS.orphaned_annotations}`);
  }
  const nextResult = contracts.validateOverlay(nextOverlay);
  if (!nextResult.ok) {
    throw new DiagramError('INVALID_OVERLAY', 'rebaseOverlay produced an invalid overlay', {
      errors: nextResult.errors,
    });
  }
  const composite = contracts.validateComposite(spec, nextOverlay);
  if (!composite.ok) {
    throw new DiagramError('INVALID_OVERLAY', 'rebaseOverlay produced an invalid composite', {
      errors: composite.errors,
    });
  }
  return { overlay: nextOverlay, orphaned };
}

exports.createEditorModel = createEditorModel;
exports.executeEdit = executeEdit;
exports.undo = undo;
exports.redo = redo;
exports.serializeEditorModel = serializeEditorModel;
exports.rebaseOverlay = rebaseOverlay;
		};
		__definitions["src/errors.mjs"] = function (module, exports, __require) {
/** Stable internal error type. Business boundaries convert it to fixed codes; raw messages never cross RPC. */
class DiagramError extends Error {
  /** @param {string} code @param {string} [message] @param {object} [details] */
  constructor(code, message, details) {
    super(message ?? code);
    this.name = 'DiagramError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

/** @param {unknown} error @returns {error is DiagramError} */
function isDiagramError(error) {
  return error instanceof DiagramError;
}

/**
 * Throw a stable coded error.
 * @param {string} code
 * @param {string} [message]
 * @param {object} [details]
 * @returns {never}
 */
function fail(code, message, details) {
  throw new DiagramError(code, message, details);
}

/**
 * Clamp/validate a non-negative safe integer argument.
 * @param {unknown} value
 * @param {string} name
 * @param {number} max
 * @returns {number}
 */
function safeInteger(value, name, max) {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new DiagramError('INVALID_INPUT', `${name} must be an integer in 0..${max}`);
  }
  return value;
}

exports.DiagramError = DiagramError;
exports.isDiagramError = isDiagramError;
exports.fail = fail;
exports.safeInteger = safeInteger;
		};
		__definitions["src/limits.mjs"] = function (module, exports, __require) {
/**
 * 06 local diagrams — engineering limits.
 *
 * These are the v1 resource defaults frozen by DIA-DESIGN-2 §4/§7. They are
 * engineering values chosen to bound memory and XML attack surface, not user
 * performance requirements. Tests exercise both sides of each boundary.
 */
const LIMITS = Object.freeze({
  // DiagramSpec (DIA-01/03)
  nodes: 500,
  edges: 1000,
  node_id_length: 128,
  edge_id_length: 128,
  label: 256,
  description: 4096,
  explanation: 4096,
  title: 256,
  scope_ref: 512,
  source_id: 128,
  snapshot_ref: 256,
  evidence_id: 128,
  repo_id: 128,
  evidence_refs_per_entity: 64,
  sources: 16,
  repos_per_source: 16,
  coverage_notes: 64,
  coverage_notes_length: 1024,

  // Annotation overlay (DIA-OVERLAY-01)
  overlay_items: 2000,
  annotation_edges: 1000,
  notes: 500,
  overlay_id_length: 128,
  position_coordinate: 100000,
  position_min_size: 1,
  position_max_size: 10000,
  orphaned_annotations: 2000,

  // Layout (DIA-03)
  node_min_width: 160,
  node_min_height: 64,
  layer_gap: 96,
  node_gap: 32,
  max_layers: 512,

  // Artifact package (DIA-04/05)
  package_bytes: 20 * 1024 * 1024,
  artifact_files: 64,
  relative_path_length: 200,
  svg_elements: 50000,
  svg_depth: 128,

  // Restricted XML (DIA-06)
  xml_bytes: 10 * 1024 * 1024,
  xml_depth: 64,
  xml_attributes_per_element: 256,
  xml_elements: 10000,
  mx_cells: 10000,
  mx_geometry_points: 4096,
  drawio_value: 4096,
  drawio_style_length: 1024,
  drawio_style_entries: 64,

  // Editor model / history (DIA-07)
  editor_history_entries: 100,
  editor_history_bytes: 2 * 1024 * 1024,
  editor_draft_revision: Number.MAX_SAFE_INTEGER,

  // Document store / save (DIA-08/09)
  document_xml_bytes: 10 * 1024 * 1024,
  editor_sessions: 64,
  editor_session_ttl_ms: 60 * 60 * 1000,
  drafts_retained: 3,
  revisions_scan: 10000,
  journal_entries_scan: 10000,

  // RPC (DIA-RPC-01)
  rpc_json_bytes: 12 * 1024 * 1024,
  rpc_response_bytes: 12 * 1024 * 1024,
  rpc_operation_id_length: 128,
  rpc_context_ref_length: 128,
  rpc_view_epoch_max: Number.MAX_SAFE_INTEGER,

  // Executor / network (DIA-05)
  executor_timeout_ms: 120000,
  executor_output_bytes: 1024 * 1024,
  executor_env_entries: 64,

  // Synthetic fixtures and CLI
  fixture_snapshot: 'snapshot',
});

/** Stable error / reason codes shared by CLI, plugin, and tests. */
const CODES = Object.freeze({
  INVALID_SPEC: 'INVALID_SPEC',
  INVALID_OVERLAY: 'INVALID_OVERLAY',
  INVALID_MANIFEST: 'INVALID_MANIFEST',
  INVALID_ACCESS_REGISTRY: 'INVALID_ACCESS_REGISTRY',
  INVALID_EDITOR_MODEL: 'INVALID_EDITOR_MODEL',
  INVALID_INPUT: 'INVALID_INPUT',
  INVALID_XML: 'INVALID_XML',
  INVALID_COMMAND: 'INVALID_COMMAND',
  INVALID_MESSAGE: 'INVALID_MESSAGE',
  LIMIT_EXCEEDED: 'LIMIT_EXCEEDED',
  DENIED: 'DENIED',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  STALE_VERSION: 'STALE_VERSION',
  OWNER_REQUIRED: 'OWNER_REQUIRED',
  CONTEXT_UNBOUND: 'CONTEXT_UNBOUND',
  SCOPE_REVOKED: 'SCOPE_REVOKED',
  DOCUMENT_DENIED: 'DOCUMENT_DENIED',
  EDITOR_SESSION_EXPIRED: 'EDITOR_SESSION_EXPIRED',
  UNKNOWN_ENDPOINT: 'UNKNOWN_ENDPOINT',
  INTERNAL_FAILURE: 'INTERNAL_FAILURE',
  UNSUPPORTED: 'UNSUPPORTED',
  OUTCOME_UNKNOWN: 'OUTCOME_UNKNOWN',
  CANCELLED: 'CANCELLED',
  FAILED: 'FAILED',
  SAVED: 'SAVED',
});

exports.LIMITS = LIMITS;
exports.CODES = CODES;
		};
		__definitions["src/schema.mjs"] = function (module, exports, __require) {
/**
 * Small, strict JSON-Schema-subset validator (no external dependency).
 *
 * Supported keywords: type (string or array), properties, required,
 * additionalProperties (false or schema), items, minItems, maxItems,
 * minLength, maxLength, pattern, minimum, maximum, enum, const, oneOf, anyOf,
 * allOf, not, description, format (annotation only).
 *
 * Deliberate limits: JSON data only; object property names are treated as
 * plain keys; `$ref` is not supported (compose schema objects by reference in
 * JavaScript instead). Validation never throws on bad data; it returns error
 * objects so business boundaries can map them to fixed reason codes.
 */

/**
 * @typedef {{ path: string, keyword: string, message: string }} SchemaIssue
 */

/**
 * @param {object} schema
 * @param {unknown} value
 * @param {string} [path]
 * @returns {SchemaIssue[]} empty when valid
 */
function validateSchema(schema, value, path = '$') {
  /** @type {SchemaIssue[]} */
  const issues = [];
  walk(schema, value, path, issues);
  return issues;
}

/**
 * @param {object} schema
 * @param {unknown} value
 * @param {string} label
 * @returns {void}
 */
function assertSchema(schema, value, label) {
  const issues = validateSchema(schema, value);
  if (issues.length > 0) {
    const error = new TypeError(`${label}: ${issues[0].path} ${issues[0].message}`);
    // @ts-ignore - attach structured issues for callers
    error.issues = issues;
    throw error;
  }
}

/**
 * @param {any} schema
 * @param {any} value
 * @param {string} path
 * @param {SchemaIssue[]} issues
 */
function walk(schema, value, path, issues) {
  if (schema === true || schema === undefined || schema === null) return;
  if (schema.const !== undefined && JSON.stringify(value) !== JSON.stringify(schema.const)) {
    issues.push({ path, keyword: 'const', message: `must equal ${JSON.stringify(schema.const)}` });
    return;
  }
  if (schema.enum !== undefined) {
    if (!schema.enum.some((/** @type {unknown} */ entry) => Object.is(entry, value))) {
      issues.push({ path, keyword: 'enum', message: `must be one of ${JSON.stringify(schema.enum)}` });
      return;
    }
  }
  if (schema.not !== undefined && validateSchema(schema.not, value, path).length === 0) {
    issues.push({ path, keyword: 'not', message: 'must not match the forbidden schema' });
    return;
  }
  if (schema.oneOf !== undefined) {
    const matches = schema.oneOf.filter((/** @type {any} */ sub) => validateSchema(sub, value, path).length === 0);
    if (matches.length !== 1) {
      issues.push({ path, keyword: 'oneOf', message: 'must match exactly one alternative' });
      return;
    }
  }
  if (schema.anyOf !== undefined) {
    const matches = schema.anyOf.some((/** @type {any} */ sub) => validateSchema(sub, value, path).length === 0);
    if (!matches) {
      issues.push({ path, keyword: 'anyOf', message: 'must match at least one alternative' });
      return;
    }
  }
  if (schema.allOf !== undefined) {
    for (const sub of schema.allOf) walk(sub, value, path, issues);
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((/** @type {string} */ type) => matchesType(type, value))) {
      issues.push({ path, keyword: 'type', message: `must be of type ${types.join('|')}` });
      return;
    }
  }
  if (typeof value === 'string') {
    const length = [...value].length;
    if (schema.minLength !== undefined && length < schema.minLength) {
      issues.push({ path, keyword: 'minLength', message: `must have at least ${schema.minLength} characters` });
    }
    if (schema.maxLength !== undefined && length > schema.maxLength) {
      issues.push({ path, keyword: 'maxLength', message: `must have at most ${schema.maxLength} characters` });
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) {
      issues.push({ path, keyword: 'pattern', message: 'must match the required pattern' });
    }
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      issues.push({ path, keyword: 'type', message: 'must be a finite number' });
      return;
    }
    if (schema.minimum !== undefined && value < schema.minimum) {
      issues.push({ path, keyword: 'minimum', message: `must be >= ${schema.minimum}` });
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      issues.push({ path, keyword: 'maximum', message: `must be <= ${schema.maximum}` });
    }
    if (schema.multipleOf !== undefined && value % schema.multipleOf !== 0) {
      issues.push({ path, keyword: 'multipleOf', message: `must be a multiple of ${schema.multipleOf}` });
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      issues.push({ path, keyword: 'minItems', message: `must have at least ${schema.minItems} items` });
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      issues.push({ path, keyword: 'maxItems', message: `must have at most ${schema.maxItems} items` });
    }
    if (schema.uniqueItems === true) {
      const seen = new Set();
      value.forEach((item, index) => {
        const key = JSON.stringify(item);
        if (seen.has(key)) issues.push({ path: `${path}[${index}]`, keyword: 'uniqueItems', message: 'must be unique' });
        seen.add(key);
      });
    }
    if (schema.items !== undefined) {
      value.forEach((item, index) => walk(schema.items, item, `${path}[${index}]`, issues));
    }
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const record = /** @type {Record<string, unknown>} */ (value);
    const keys = Object.keys(record);
    const properties = schema.properties ?? {};
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(properties, key)) continue;
      if (schema.additionalProperties === false) {
        issues.push({ path: `${path}.${key}`, keyword: 'additionalProperties', message: 'is not an allowed property' });
        continue;
      }
      if (schema.additionalProperties !== undefined && typeof schema.additionalProperties === 'object') {
        walk(schema.additionalProperties, record[key], `${path}.${key}`, issues);
      }
    }
    for (const [key, sub] of Object.entries(properties)) {
      if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
      walk(sub, record[key], `${path}.${key}`, issues);
    }
    for (const key of schema.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(record, key) || record[key] === undefined) {
        issues.push({ path: `${path}.${key}`, keyword: 'required', message: 'is required' });
      }
    }
  }
}

/**
 * @param {string} type
 * @param {unknown} value
 * @returns {boolean}
 */
function matchesType(type, value) {
  switch (type) {
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return Number.isSafeInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    default:
      throw new TypeError(`unknown schema type: ${type}`);
  }
}

exports.validateSchema = validateSchema;
exports.assertSchema = assertSchema;
		};
		__definitions["ui/client-entry.mjs"] = function (module, exports, __require) {
/**
 * Client bundle entry (ui/client-entry.mjs), inlined into plugin/client.js by
 * tools/build-client.mjs.
 *
 * rc.5 lazy-CJS contract: the generated bundle registers
 * `window.__ModuleLoader__.load({id:'dsh-local-diagrams', factory(require){...}})`
 * and the factory returns this module's exports. The loader treats an object with
 * `name`/`inject`/`apply` as one client plugin (same shape as the shipped
 * `@deepseek-ai/dsh-client-ui-*` bundles).
 *
 * The `apply` body is the only Host-facing seam:
 *  - `inject: ['slots','layout','connection']`;
 *  - registers the `main` keyed slot entry `{name:'main', key:'local-diagrams'}`
 *    with a wrapper that closes over this plugin's ctx and renders the panel;
 *  - the panel calls the authenticated `/local-diagrams` RPC channel through
 *    `ctx.connection.rpc.call` and never touches XML files directly.
 *
 * `__test` exposes the inlined pure modules so Node tests (and the isolated
 * editor smoke) can drive the SAME code the browser runs under a fake
 * `window.__ModuleLoader__` + fake `require`.
 */

const { createElement: h } = __require("react");

const { LocalDiagramsPanel: LocalDiagramsPanelComponent } = __require("ui/panel.mjs");
const rpc = __require("ui/rpc.mjs");
const commands = __require("ui/commands.mjs");
const view = __require("ui/view-model.mjs");
const xmlDraft = __require("ui/xml-draft.mjs");
const conflict = __require("ui/conflict.mjs");
const hash = __require("ui/hash.mjs");
const descriptor = __require("src/descriptor.mjs");
const { createEditorModel, executeEdit, rebaseOverlay, redo, undo } = __require("src/editor/model.mjs");
const { canonicalMxGraph, exportDrawio, parseDrawioXml } = __require("src/drawio/xml.mjs");

const name = 'local-diagrams';
const inject = ['slots', 'layout', 'connection'];
const PANEL_KEY = 'local-diagrams';
const PANEL_SLOT = 'main';
const LocalDiagramsPanel = LocalDiagramsPanelComponent;

/**
 * Client plugin body. Throws (loudly) when the Host wiring is missing; never
 * silently registers half a panel.
 * @param {any} ctx rc.5 client root context
 */
function apply(ctx) {
  if (!ctx || !ctx.slots || typeof ctx.slots.inject !== 'function' || typeof ctx.slots.register !== 'function') {
    throw new TypeError('local-diagrams client: ctx.slots.inject/register are required (inject: [slots])');
  }
  if (!ctx.connection || !ctx.connection.rpc || typeof ctx.connection.rpc.call !== 'function') {
    throw new TypeError('local-diagrams client: ctx.connection.rpc.call is required (inject: [connection])');
  }
  ctx.slots.inject(PANEL_SLOT, () => ctx.slots.register({ name: PANEL_SLOT, key: PANEL_KEY }, function LocalDiagramsSlot(props) {
    return h(LocalDiagramsPanel, { ...props, ctx });
  }));
}

/** Inlined pure modules for Node tests / the isolated editor smoke. */
const __test = Object.freeze({
  rpc,
  commands,
  view,
  xmlDraft,
  conflict,
  hash,
  descriptor,
  editor: Object.freeze({ createEditorModel, executeEdit, undo, redo, rebaseOverlay }),
  drawio: Object.freeze({ exportDrawio, parseDrawioXml, canonicalMxGraph }),
});

exports.name = name;
exports.inject = inject;
exports.PANEL_KEY = PANEL_KEY;
exports.PANEL_SLOT = PANEL_SLOT;
exports.LocalDiagramsPanel = LocalDiagramsPanel;
exports.apply = apply;
exports.__test = __test;
		};
		__definitions["ui/commands.mjs"] = function (module, exports, __require) {
/**
 * Pure editor interaction helpers for the local SVG editor (ui/commands.mjs).
 *
 * Maps DOM-free interaction state to the frozen DIA-API-EDIT command union from
 * docs/software-design.md §7; the actual command semantics live in
 * `src/editor/model.mjs` (inlined into the built client bundle). Keeping the
 * mapping here means drag/keyboard/form behaviour is Node-testable without a
 * DOM and the panel stays a thin renderer.
 *
 * Rules encoded here:
 *  - pointer drag uses a captured pointer id, moves are visual only, and exactly
 *    one `move_node` command is committed on pointerup; cancel commits nothing;
 *  - keyboard arrows move 8 px, Shift+arrows 1 px;
 *  - a coordinate form is the no-drag fallback (integers inside the overlay
 *    coordinate range);
 *  - every command carries `command_id` and `expected_draft_revision` and is
 *    applied through `executeEdit`, never fabricated by the RPC layer.
 */

const { executeEdit } = __require("src/editor/model.mjs");

const KEYBOARD_STEP = 8;
const KEYBOARD_FINE_STEP = 1;
const POSITION_MIN = -100000;
const POSITION_MAX = 100000;
const DEFAULT_POSITION = Object.freeze({ x: 0, y: 0, width: 160, height: 64 });
const ARROW_KEYS = Object.freeze(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+~=-]*$/u;

/** @param {unknown} value @returns {boolean} */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** @param {unknown} value @returns {boolean} */
function isSafeInteger(value) {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

/**
 * Clamp one coordinate into the overlay range.
 * @param {number} value
 * @returns {number}
 */
function clampCoordinate(value) {
  const rounded = Number.isFinite(value) ? Math.round(value) : 0;
  return Math.min(POSITION_MAX, Math.max(POSITION_MIN, rounded));
}

/**
 * @param {number} value
 * @returns {boolean}
 */
function inCoordinateRange(value) {
  return isSafeInteger(value) && value >= POSITION_MIN && value <= POSITION_MAX;
}

/**
 * Build a deterministic, unique command id (the model dedupes on it).
 * @param {string} kind
 * @param {number} draftRevision
 * @param {number} sequence
 * @returns {string}
 */
function makeCommandId(kind, draftRevision, sequence) {
  const id = `cmd:${String(kind).slice(0, 32)}:${Math.max(0, Math.trunc(draftRevision))}:${Math.max(0, Math.trunc(sequence))}`;
  return id.length <= 128 ? id : id.slice(0, 128);
}

/**
 * Hidden-safe node position lookup used for drag start and keyboard moves.
 * Reads an annotation node position, then a layout override, then the base
 * layout, then the default node size. `baseSpec` is the canonical base spec the
 * panel received from `document.open` (the editor model keeps it non-enumerable).
 *
 * @param {any} model EditorModelV1
 * @param {string} nodeId
 * @param {any} [baseSpec]
 * @returns {{x:number,y:number,width:number,height:number}|null}
 */
function nodePosition(model, nodeId, baseSpec) {
  if (!isRecord(model) || !isRecord(model.overlay)) return null;
  const items = Array.isArray(model.overlay.items) ? model.overlay.items : [];
  const annotation = items.find((item) => item.id === nodeId && item.kind === 'annotation_node');
  if (annotation !== undefined) return annotation.position;
  const layout = items.find((item) => item.kind === 'layout' && item.target_ref === nodeId);
  if (layout !== undefined) return layout.position;
  const positions = Array.isArray(baseSpec?.layout?.positions) ? baseSpec.layout.positions : [];
  const fromSpec = positions.find((entry) => entry?.node_id === nodeId);
  if (fromSpec !== undefined) return fromSpec;
  return null;
}

/**
 * Begin one pointer drag. `position` is the node's current rectangle.
 * @param {{node_id:string, pointer_id:number, position:{x:number,y:number,width:number,height:number}, client_x:number, client_y:number}} input
 * @returns {{ok:true, drag:any} | {ok:false, errors:Array<{path:string,message:string}>}}
 */
function beginDrag(input) {
  if (!isRecord(input) || typeof input.node_id !== 'string' || input.node_id.length === 0) {
    return { ok: false, errors: [{ path: '$.node_id', message: 'node_id is required' }] };
  }
  if (!isSafeInteger(input.pointer_id)) {
    return { ok: false, errors: [{ path: '$.pointer_id', message: 'pointer_id must be an integer' }] };
  }
  const position = isRecord(input.position) ? input.position : DEFAULT_POSITION;
  if (!Number.isFinite(input.client_x) || !Number.isFinite(input.client_y)) {
    return { ok: false, errors: [{ path: '$.client_x', message: 'drag start needs finite client coordinates' }] };
  }
  return {
    ok: true,
    drag: {
      node_id: input.node_id,
      pointer_id: input.pointer_id,
      start_client_x: input.client_x,
      start_client_y: input.client_y,
      start_x: inCoordinateRange(position.x) ? position.x : 0,
      start_y: inCoordinateRange(position.y) ? position.y : 0,
      moved: false,
      committed: false,
    },
  };
}

/**
 * Visual-only drag update: returns the candidate position (clamped ints).
 * @param {any} drag
 * @param {{client_x:number, client_y:number}} point
 * @returns {{x:number,y:number,dx:number,dy:number}}
 */
function updateDrag(drag, point) {
  const dx = Number.isFinite(point?.client_x) ? point.client_x - drag.start_client_x : 0;
  const dy = Number.isFinite(point?.client_y) ? point.client_y - drag.start_client_y : 0;
  return {
    x: clampCoordinate(drag.start_x + dx),
    y: clampCoordinate(drag.start_y + dy),
    dx,
    dy,
  };
}

/**
 * Commit exactly one move command on pointerup. A cancelled drag commits
 * nothing; a drag whose position did not change still yields a single command
 * (idempotent layout write) so the UI history matches the pointer gesture.
 *
 * @param {any} drag
 * @param {{client_x?:number, client_y?:number}} [point]
 * @returns {{ok:true, payload:{node_id:string,x:number,y:number}} | {ok:false, errors:Array<{path:string,message:string}>}}
 */
function commitDrag(drag, point) {
  if (!isRecord(drag) || drag.committed === true) {
    return { ok: false, errors: [{ path: '$', message: 'drag is not active' }] };
  }
  const clientX = Number.isFinite(point?.client_x) ? point.client_x : drag.start_client_x;
  const clientY = Number.isFinite(point?.client_y) ? point.client_y : drag.start_client_y;
  const next = updateDrag(drag, { client_x: clientX, client_y: clientY });
  drag.committed = true;
  return { ok: true, payload: { node_id: drag.node_id, x: next.x, y: next.y } };
}

/**
 * @param {any} drag
 * @returns {void}
 */
function cancelDrag(drag) {
  if (isRecord(drag)) drag.committed = true;
}

/**
 * Keyboard move mapping: arrows 8 px, Shift+arrows 1 px. Returns a `move_node`
 * payload, or `{ok:false, reason:'not_arrow'}` for any other key so the panel
 * can leave the event alone.
 *
 * @param {{node_id:string, position:{x:number,y:number}, key:string, shift?:boolean}} input
 * @returns {{ok:true, payload:{node_id:string,x:number,y:number}, step:number} | {ok:false, reason:string, errors?:any[]}}
 */
function keyboardMove(input) {
  if (!isRecord(input) || !ARROW_KEYS.includes(input.key)) return { ok: false, reason: 'not_arrow' };
  const position = isRecord(input.position) ? input.position : DEFAULT_POSITION;
  const step = input.shift === true ? KEYBOARD_FINE_STEP : KEYBOARD_STEP;
  let x = inCoordinateRange(position.x) ? position.x : 0;
  let y = inCoordinateRange(position.y) ? position.y : 0;
  if (input.key === 'ArrowLeft') x -= step;
  else if (input.key === 'ArrowRight') x += step;
  else if (input.key === 'ArrowUp') y -= step;
  else y += step;
  return { ok: true, payload: { node_id: input.node_id, x: clampCoordinate(x), y: clampCoordinate(y) }, step };
}

/**
 * Form coordinate fallback. Accepts decimal integer strings or numbers.
 * @param {{node_id:string, x:unknown, y:unknown}} input
 * @returns {{ok:true, payload:{node_id:string,x:number,y:number}} | {ok:false, errors:Array<{path:string,message:string}>}}
 */
function coordinateMove(input) {
  if (!isRecord(input) || typeof input.node_id !== 'string' || input.node_id.length === 0) {
    return { ok: false, errors: [{ path: '$.node_id', message: 'node_id is required' }] };
  }
  /** @type {Array<{path:string,message:string}>} */
  const errors = [];
  /** @param {'x'|'y'} field @returns {number} */
  const parse = (field) => {
    const raw = input[field];
    if (isSafeInteger(raw)) return raw;
    if (typeof raw === 'string' && /^-?\d{1,7}$/u.test(raw.trim())) return Number.parseInt(raw.trim(), 10);
    errors.push({ path: `$.${field}`, message: `${field} must be an integer between ${POSITION_MIN} and ${POSITION_MAX}` });
    return 0;
  };
  const x = parse('x');
  const y = parse('y');
  if (errors.length === 0) {
    if (!inCoordinateRange(x)) errors.push({ path: '$.x', message: `x must be within ${POSITION_MIN}..${POSITION_MAX}` });
    if (!inCoordinateRange(y)) errors.push({ path: '$.y', message: `y must be within ${POSITION_MIN}..${POSITION_MAX}` });
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, payload: { node_id: input.node_id, x, y } };
}

/**
 * Wrap a payload in the frozen command envelope. `expected_draft_revision`
 * always comes from the current model so a stale UI cannot silently mutate a
 * newer draft.
 * @param {{model:any, kind:string, payload:any, sequence:number}} input
 * @returns {any}
 */
function buildCommand(input) {
  const revision = isRecord(input?.model) && isSafeInteger(input.model.draft_revision) ? input.model.draft_revision : 0;
  return {
    command_id: makeCommandId(input.kind, revision, input.sequence),
    expected_draft_revision: revision,
    kind: input.kind,
    payload: input.payload,
  };
}

/**
 * Apply one command through the editor model. Returns the model result shape
 * (`{status:'ok',model,inverse}` or `{status:'stale'|'invalid',code,errors}`).
 * @param {any} model
 * @param {any} command
 * @param {{now?:string, clock?:()=>string}} [options]
 * @returns {any}
 */
function applyCommand(model, command, options) {
  return executeEdit(model, command, options);
}

/**
 * Convenience wrapper: build + apply in one call.
 * @param {{model:any, kind:string, payload:any, sequence:number, now?:string}} input
 * @returns {any}
 */
function runEdit(input) {
  const command = buildCommand(input);
  return executeEdit(input.model, command, input.now === undefined ? {} : { now: input.now });
}

/** @param {number} step @returns {string} */
function describeStep(step) {
  return step === KEYBOARD_FINE_STEP ? '1 px' : '8 px';
}

/* -------------------------------------------------------------------------- */
/* annotation command builders                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Deterministic annotation id (`ann:` prefix required by the overlay contract;
 * never collides with a base entity whose ids cannot start with `ann:` when the
 * editor checks `remove_annotation_node`).
 * @param {'note'|'node'|'edge'} kind
 * @param {number} sequence
 * @returns {string}
 */
function makeAnnotationId(kind, sequence) {
  const safeKind = ['note', 'node', 'edge'].includes(kind) ? kind : 'node';
  return `ann:${safeKind}-${Math.max(0, Math.trunc(sequence))}`;
}

/**
 * Existing note item bound to a target, if any.
 * @param {any} model
 * @param {string|null} targetRef
 * @returns {any|null}
 */
function noteForTarget(model, targetRef) {
  const items = Array.isArray(model?.overlay?.items) ? model.overlay.items : [];
  return items.find((item) => item.kind === 'note' && item.target_ref === targetRef) ?? null;
}

/**
 * `set_note` payload. Creates a new note or updates the same-id note.
 * @param {{annotation_id:string, target_ref:string|null, text:string, position:{x:number,y:number,width:number,height:number}}} input
 * @returns {any}
 */
function notePayload(input) {
  const position = isRecord(input.position) ? input.position : DEFAULT_POSITION;
  return {
    annotation_id: input.annotation_id,
    target_ref: input.target_ref === undefined ? null : input.target_ref,
    text: String(input.text ?? ''),
    position: {
      x: clampCoordinate(position.x),
      y: clampCoordinate(position.y),
      width: Math.max(1, Math.min(10000, Math.trunc(position.width ?? DEFAULT_POSITION.width))),
      height: Math.max(1, Math.min(10000, Math.trunc(position.height ?? DEFAULT_POSITION.height))),
    },
  };
}

/** @param {{id:string,label:string,description?:string|null,position:any}} input @returns {any} */
function annotationNodePayload(input) {
  const position = isRecord(input.position) ? input.position : DEFAULT_POSITION;
  return {
    id: input.id,
    label: String(input.label ?? ''),
    description: input.description === undefined ? null : input.description,
    position: {
      x: clampCoordinate(position.x),
      y: clampCoordinate(position.y),
      width: Math.max(1, Math.min(10000, Math.trunc(position.width ?? DEFAULT_POSITION.width))),
      height: Math.max(1, Math.min(10000, Math.trunc(position.height ?? DEFAULT_POSITION.height))),
    },
  };
}

/** @param {{id:string,from:string,to:string,label?:string,description?:string|null}} input @returns {any} */
function annotationEdgePayload(input) {
  return {
    id: input.id,
    from: input.from,
    to: input.to,
    label: String(input.label ?? ''),
    description: input.description === undefined ? null : input.description,
  };
}

/** @param {{id:string}} input @returns {any} */
function removeAnnotationPayload(input) {
  return { id: input.id };
}

/** @param {{node_id:string}} input @returns {any} */
function removeAnnotationNodePayload(input) {
  return { node_id: input.node_id };
}

/** @param {{target_ref:string,hidden:boolean}} input @returns {any} */
function visibilityPayload(input) {
  return { target_ref: input.target_ref, hidden: input.hidden === true };
}

/**
 * Is this id a valid document-entity id for command payloads?
 * @param {unknown} value
 * @returns {boolean}
 */
function isEntityId(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= 128 && ID_PATTERN.test(value);
}

/**
 * "Keep both" merge used after a save conflict: the current Host overlay is
 * merged with the local draft overlay. Local items win (they are the edits the
 * user just made), Host items whose id is not present locally are preserved, and
 * a Host layout/visibility item loses to a local item for the same target so the
 * unique-per-target invariant holds. The caller must still validate the merged
 * overlay against its base spec (validateComposite) before editing/saving.
 *
 * @param {any} hostOverlay current Host AnnotationOverlayV1
 * @param {any} localOverlay local draft overlay
 * @returns {any[]} merged item list (local first)
 */
function mergeOverlayItems(hostOverlay, localOverlay) {
  const localItems = Array.isArray(localOverlay?.items) ? localOverlay.items : [];
  const hostItems = Array.isArray(hostOverlay?.items) ? hostOverlay.items : [];
  const localIds = new Set(localItems.map((item) => item?.id));
  const localTargets = new Set(
    localItems
      .filter((item) => item?.kind === 'layout' || item?.kind === 'visibility')
      .map((item) => `${item.kind}\u0000${item.target_ref}`),
  );
  const merged = localItems.map((item) => structuredClone(item));
  for (const item of hostItems) {
    if (!isRecord(item) || localIds.has(item.id)) continue;
    if (item.kind === 'layout' || item.kind === 'visibility') {
      if (localTargets.has(`${item.kind}\u0000${item.target_ref}`)) continue;
    }
    merged.push(structuredClone(item));
  }
  return merged;
}

exports.KEYBOARD_STEP = KEYBOARD_STEP;
exports.KEYBOARD_FINE_STEP = KEYBOARD_FINE_STEP;
exports.POSITION_MIN = POSITION_MIN;
exports.POSITION_MAX = POSITION_MAX;
exports.DEFAULT_POSITION = DEFAULT_POSITION;
exports.ARROW_KEYS = ARROW_KEYS;
exports.clampCoordinate = clampCoordinate;
exports.makeCommandId = makeCommandId;
exports.nodePosition = nodePosition;
exports.beginDrag = beginDrag;
exports.updateDrag = updateDrag;
exports.commitDrag = commitDrag;
exports.cancelDrag = cancelDrag;
exports.keyboardMove = keyboardMove;
exports.coordinateMove = coordinateMove;
exports.buildCommand = buildCommand;
exports.applyCommand = applyCommand;
exports.runEdit = runEdit;
exports.describeStep = describeStep;
exports.makeAnnotationId = makeAnnotationId;
exports.noteForTarget = noteForTarget;
exports.notePayload = notePayload;
exports.annotationNodePayload = annotationNodePayload;
exports.annotationEdgePayload = annotationEdgePayload;
exports.removeAnnotationPayload = removeAnnotationPayload;
exports.removeAnnotationNodePayload = removeAnnotationNodePayload;
exports.visibilityPayload = visibilityPayload;
exports.isEntityId = isEntityId;
exports.mergeOverlayItems = mergeOverlayItems;
		};
		__definitions["ui/conflict.mjs"] = function (module, exports, __require) {
/**
 * Save/conflict state helpers for the local editor panel (ui/conflict.mjs).
 *
 * DIA-DESIGN-2 §8: a stale `expected_version` is a conflict, never an automatic
 * retry with a fresh token; the user keeps both sides, exports the local draft,
 * or reopens explicitly. When a write outcome is unknown the UI offers a
 * scoped `operation.get` poll (one in flight, stop on panel close/scope change)
 * instead of blind resubmission.
 *
 * Pure module: state machines and fixed UI text only, no DOM and no transport.
 */

/** Fixed user-facing text per save reason code; never echo server messages. */
const SAVE_REASON_MESSAGES = Object.freeze({
  STALE_VERSION: 'The document changed in another view. Nothing was overwritten.',
  EDITOR_SESSION_EXPIRED: 'The editor session expired. Reopen the document to continue.',
  DOCUMENT_DENIED: 'This document is no longer available for editing.',
  SCOPE_REVOKED: 'The workspace scope changed. Reopen the document from the registered reference.',
  CONTEXT_UNBOUND: 'This document is not registered in the current scope.',
  INVALID_XML: 'The editor produced XML the local validator rejected. Your draft was not saved.',
  INVALID_OVERLAY: 'The local annotation overlay does not match the document base. Nothing was saved.',
  LIMIT_EXCEEDED: 'The document or overlay exceeds the local size limits.',
  UNSUPPORTED_FORMAT: 'The requested export format is not supported locally.',
  OUTCOME_UNKNOWN: 'The save result is unknown. Check the operation status before retrying.',
  CANCELLED: 'The save was cancelled before it completed.',
  OPERATION_CONFLICT: 'This save operation was already used with different content. Reopen and save again.',
  EXPORT_EXISTS: 'A file with this name already exists in the output directory. Nothing was overwritten.',
  INTERNAL_FAILURE: 'The local editor failed unexpectedly. Nothing was overwritten.',
  OWNER_REQUIRED: 'The local editor channel requires the application owner session.',
  UNKNOWN_ENDPOINT: 'The local editor channel does not support this action.',
  INVALID_REQUEST: 'The editor sent an invalid request.',
});

/** Actions offered for each save failure. */
const SAVE_ACTIONS = Object.freeze({
  STALE_VERSION: Object.freeze(['keep_both', 'export_draft', 'reopen']),
  OUTCOME_UNKNOWN: Object.freeze(['check_status', 'export_draft']),
  CANCELLED: Object.freeze(['check_status', 'export_draft']),
});

const CONFLICT_OPTIONS = Object.freeze([
  Object.freeze({
    id: 'keep_both',
    label: 'Keep both',
    description: 'Reopen the current Host version, rebase the local annotations onto it and save as a new revision.',
  }),
  Object.freeze({
    id: 'export_draft',
    label: 'Export draft',
    description: 'Download the local XML + overlay draft as a JSON file. Nothing is written to the document.',
  }),
  Object.freeze({
    id: 'reopen',
    label: 'Reopen',
    description: 'Discard the local draft and reload the current Host version.',
  }),
]);

const OPTION_IDS = new Set(CONFLICT_OPTIONS.map((option) => option.id));

/**
 * Describe the failure state for the panel.
 * @param {{status:string, reason_code:string, data?:any}} failure
 * @returns {{title:string, message:string, actions:string[], conflict:any|null}}
 */
function describeSaveFailure(failure) {
  const reason = typeof failure?.reason_code === 'string' ? failure.reason_code : 'INTERNAL_FAILURE';
  const message = SAVE_REASON_MESSAGES[reason] ?? SAVE_REASON_MESSAGES.INTERNAL_FAILURE;
  if (failure?.status === 'conflict') {
    return {
      title: 'Save conflict',
      message,
      actions: [...(SAVE_ACTIONS.STALE_VERSION ?? [])],
      conflict: {
        current_version: failure?.data?.current_version ?? null,
        draft_ref: typeof failure?.data?.draft_ref === 'string' ? failure.data.draft_ref : null,
      },
    };
  }
  if (reason === 'OUTCOME_UNKNOWN' || reason === 'CANCELLED') {
    return { title: 'Save status unknown', message, actions: [...SAVE_ACTIONS.OUTCOME_UNKNOWN], conflict: null };
  }
  if (reason === 'STALE_VERSION') {
    return { title: 'Save conflict', message, actions: [...SAVE_ACTIONS.STALE_VERSION], conflict: null };
  }
  return { title: 'Save failed', message, actions: [], conflict: null };
}

/**
 * Build the conflict view model.
 * @param {{current_version:any, draft_ref?:string|null, local_overlay?:any, document_id?:string}} input
 * @returns {any}
 */
function conflictView(input) {
  const currentVersion = input?.current_version ?? null;
  return {
    kind: 'conflict',
    title: 'Save conflict',
    message: SAVE_REASON_MESSAGES.STALE_VERSION,
    options: CONFLICT_OPTIONS.map((option) => ({ ...option })),
    current_version: currentVersion,
    current_generation: Number.isSafeInteger(currentVersion?.generation) ? currentVersion.generation : null,
    draft_ref: typeof input?.draft_ref === 'string' ? input.draft_ref : null,
    has_local_state: input?.local_overlay !== undefined && input?.local_overlay !== null,
  };
}

/**
 * Resolve the user's conflict choice into a plan. The panel executes the plan;
 * this function only validates and describes it.
 *
 * @param {{choice:string, current_version:any, local?:{base_spec?:any, overlay?:any}}} input
 * @returns {{ok:true, action:'reopen_then_resave'|'download_draft'|'reopen', expected_version:any} | {ok:false, code:string}}
 */
function resolveConflict(input) {
  if (typeof input?.choice !== 'string' || !OPTION_IDS.has(input.choice)) {
    return { ok: false, code: 'INVALID_REQUEST' };
  }
  if (input.choice === 'export_draft') {
    return { ok: true, action: 'download_draft', expected_version: null };
  }
  const currentVersion = input?.current_version;
  if (!currentVersion || typeof currentVersion !== 'object' || !Number.isSafeInteger(currentVersion.generation)) {
    return { ok: false, code: 'STALE_VERSION' };
  }
  if (input.choice === 'keep_both') {
    return { ok: true, action: 'reopen_then_resave', expected_version: currentVersion };
  }
  return { ok: true, action: 'reopen', expected_version: currentVersion };
}

/**
 * Plan an `operation.get` poll for an unknown save outcome.
 * @param {{attempt:number, max_attempts?:number, operation_ref:string, state?:string}} input
 * @returns {{poll:boolean, delay_ms:number, operation_ref:string|null, next_attempt:number, stop_reason:string|null}}
 */
function operationPollPlan(input) {
  const attempt = Number.isSafeInteger(input?.attempt) && input.attempt >= 0 ? input.attempt : 0;
  const maxAttempts = Number.isSafeInteger(input?.max_attempts) ? input.max_attempts : 30;
  const operationRef = typeof input?.operation_ref === 'string' && input.operation_ref.length > 0 ? input.operation_ref : null;
  if (operationRef === null) {
    return { poll: false, delay_ms: 0, operation_ref: null, next_attempt: attempt, stop_reason: 'no_operation_ref' };
  }
  if (attempt >= maxAttempts) {
    return { poll: false, delay_ms: 0, operation_ref: operationRef, next_attempt: attempt, stop_reason: 'max_attempts' };
  }
  if (input?.state === 'saved' || input?.state === 'failed') {
    return { poll: false, delay_ms: 0, operation_ref: operationRef, next_attempt: attempt, stop_reason: `state_${input.state}` };
  }
  return { poll: true, delay_ms: 1000, operation_ref: operationRef, next_attempt: attempt + 1, stop_reason: null };
}

/**
 * Should the panel accept a response for the current view epoch? Stale-epoch
 * responses are ignored instead of overwriting a replaced document view.
 * @param {{response_view_epoch:number, current_view_epoch:number}} input
 * @returns {boolean}
 */
function acceptsViewEpoch(input) {
  return (
    Number.isSafeInteger(input?.response_view_epoch) &&
    Number.isSafeInteger(input?.current_view_epoch) &&
    input.response_view_epoch === input.current_view_epoch
  );
}

/**
 * Describe the operation.get result for an unknown save.
 * @param {{state:string, version?:any, reason_code?:string}} data
 * @returns {{state:string, message:string, recovered_version:any|null}}
 */
function describeOperationResult(data) {
  const state = typeof data?.state === 'string' ? data.state : 'unknown';
  if (state === 'saved') {
    return { state, message: 'The save completed on the Host.', recovered_version: data?.version ?? null };
  }
  if (state === 'failed') {
    const reason = typeof data?.reason_code === 'string' ? data.reason_code : 'INTERNAL_FAILURE';
    return {
      state,
      message: SAVE_REASON_MESSAGES[reason] ?? SAVE_REASON_MESSAGES.INTERNAL_FAILURE,
      recovered_version: null,
    };
  }
  if (state === 'pending' || state === 'revision_written') {
    return { state, message: 'The save is still being finalized on the Host.', recovered_version: null };
  }
  return { state: 'unknown', message: 'No Host record of this operation was found.', recovered_version: null };
}

exports.SAVE_REASON_MESSAGES = SAVE_REASON_MESSAGES;
exports.SAVE_ACTIONS = SAVE_ACTIONS;
exports.CONFLICT_OPTIONS = CONFLICT_OPTIONS;
exports.describeSaveFailure = describeSaveFailure;
exports.conflictView = conflictView;
exports.resolveConflict = resolveConflict;
exports.operationPollPlan = operationPollPlan;
exports.acceptsViewEpoch = acceptsViewEpoch;
exports.describeOperationResult = describeOperationResult;
		};
		__definitions["ui/hash.mjs"] = function (module, exports, __require) {
/**
 * Browser-safe SHA-256 for the generated client bundle (ui/hash.mjs).
 *
 * tools/build-client.mjs maps the inlined `src/canonical.mjs` import of
 * `node:crypto` to this module, so the client can compute the same canonical
 * digests as the Host (spec digests, editor command ids, save XML
 * `data_base_digest`) without Node builtins, third-party packages, WebCrypto
 * promises or `eval`. Only SHA-256 with hex/base64 digests is implemented, which
 * is the complete surface `src/canonical.mjs` uses.
 *
 * Node tests compare every output against `node:crypto` (tests/client-bundle).
 */

/** @param {string | Uint8Array} data @returns {Uint8Array} */
function toBytes(data) {
  if (typeof data === 'string') {
    if (typeof TextEncoder === 'function') return new TextEncoder().encode(data);
    // Minimal UTF-8 fallback (never reached in browsers or Node >= 11).
    const encoded = unescape(encodeURIComponent(data));
    const bytes = new Uint8Array(encoded.length);
    for (let index = 0; index < encoded.length; index += 1) bytes[index] = encoded.charCodeAt(index);
    return bytes;
  }
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  throw new TypeError('sha256 input must be a string, Uint8Array or ArrayBuffer');
}

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** @param {number} value @param {number} shift @returns {number} */
function rotr(value, shift) {
  return (value >>> shift) | (value << (32 - shift));
}

/** @param {Uint8Array} bytes @returns {Uint8Array} 32-byte digest */
function sha256Bytes(bytes) {
  const length = bytes.length;
  // padded length: message + 0x80 + zero pad + 64-bit big-endian bit length, 64-byte blocks
  const paddedLength = (((length + 8) >> 6) + 1) << 6;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[length] = 0x80;
  const view = new DataView(padded.buffer);
  const bitLength = length * 8;
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(paddedLength - 4, bitLength >>> 0);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;
  const w = new Uint32Array(64);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) w[index] = view.getUint32(offset + index * 4);
    for (let index = 16; index < 64; index += 1) {
      const s0 = rotr(w[index - 15], 7) ^ rotr(w[index - 15], 18) ^ (w[index - 15] >>> 3);
      const s1 = rotr(w[index - 2], 17) ^ rotr(w[index - 2], 19) ^ (w[index - 2] >>> 10);
      w[index] = (w[index - 16] + s0 + w[index - 7] + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let index = 0; index < 64; index += 1) {
      const sigma1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temp1 = (h + sigma1 + choose + K[index] + w[index]) >>> 0;
      const sigma0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sigma0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  const digest = new Uint8Array(32);
  const digestView = new DataView(digest.buffer);
  const words = [h0, h1, h2, h3, h4, h5, h6, h7];
  for (let index = 0; index < 8; index += 1) digestView.setUint32(index * 4, words[index]);
  return digest;
}

const HEX = '0123456789abcdef';

/** @param {Uint8Array} bytes @returns {string} */
function toHex(bytes) {
  let out = '';
  for (let index = 0; index < bytes.length; index += 1) {
    out += HEX[bytes[index] >> 4] + HEX[bytes[index] & 0x0f];
  }
  return out;
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** @param {Uint8Array} bytes @returns {string} */
function toBase64(bytes) {
  let out = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index];
    const b = index + 1 < bytes.length ? bytes[index + 1] : 0;
    const c = index + 2 < bytes.length ? bytes[index + 2] : 0;
    out += BASE64[a >> 2];
    out += BASE64[((a & 0x03) << 4) | (b >> 4)];
    out += index + 1 < bytes.length ? BASE64[((b & 0x0f) << 2) | (c >> 6)] : '=';
    out += index + 2 < bytes.length ? BASE64[c & 0x3f] : '=';
  }
  return out;
}

/**
 * `node:crypto#createHash` subset for SHA-256 (hex/base64/undefined digest).
 * @param {string} algorithm
 * @returns {{update:(data:string|Uint8Array)=>any, digest:(encoding?:'hex'|'base64')=>string}}
 */
function createHash(algorithm) {
  if (algorithm !== 'sha256') throw new Error('unsupported hash algorithm');
  /** @type {Uint8Array[]} */
  const chunks = [];
  return {
    update(data) {
      chunks.push(toBytes(data));
      return this;
    },
    digest(encoding) {
      const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      const joined = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        joined.set(chunk, offset);
        offset += chunk.length;
      }
      const digest = sha256Bytes(joined);
      if (encoding === 'hex' || encoding === undefined) return toHex(digest);
      if (encoding === 'base64') return toBase64(digest);
      throw new Error('unsupported digest encoding');
    },
  };
}

/**
 * @param {string | Uint8Array} data
 * @returns {string} lowercase hex sha256
 */
function sha256Hex(data) {
  return toHex(sha256Bytes(toBytes(data)));
}

exports.sha256Bytes = sha256Bytes;
exports.toHex = toHex;
exports.createHash = createHash;
exports.sha256Hex = sha256Hex;
		};
		__definitions["ui/panel.mjs"] = function (module, exports, __require) {
/**
 * Default local editor panel (ui/panel.mjs) - the React view registered into the
 * rc.5 main keyed slot as `local-diagrams` by ui/client-entry.mjs.
 *
 * Behaviour (DIA-DESIGN-2 §7/§9.1, docs/interfaces.md §11):
 *  - displays the Host-provided canonical base + local annotation overlay as a
 *    whitelisted SVG scene (all elements/attributes come from ui/view-model.mjs),
 *    with source/version bar, certainty legend, unresolved/truncated warnings,
 *    hidden-entity counts, orphaned-annotation count and a text-equivalent list;
 *  - editing commands are executed locally through `src/editor/model.mjs`
 *    (inlined); the Host is only contacted on open/save/export/status/close;
 *  - node drag uses Pointer Events + pointer capture and commits exactly one
 *    `move_node` command on pointerup; cancel commits nothing; arrow keys move
 *    8 px (Shift 1 px); a coordinate form is the no-drag fallback;
 *  - notes, conceptual annotation nodes, annotation edges, annotation removal,
 *    annotation-node relabel and base visibility are all regular command-union
 *    edits; undo/redo replay the model history;
 *  - save sends the model overlay + XML built by the same deterministic exporter
 *    as the Host with the exact `expected_version`; conflicts show keep
 *    both/export draft/reopen; an unknown outcome polls `operation.get` once per
 *    second with one request in flight;
 *  - every RPC result is interpreted by ui/rpc.mjs (`result.ok` first, closed-union
 *    validation, stale-epoch responses ignored); no server message/path is shown;
 *  - only whitelisted DOM/SVG elements are created; no eval/new Function/fetch/
 *    WebSocket/remote URLs. Document references come from a small in-memory
 *    recent list or the 08 navigation event, and the Host registry validates
 *    every open.
 */

const { createElement: h, useCallback, useEffect, useMemo, useRef, useState } = __require("react");

const { OPEN_EVENT, validateOpenEventDetail } = __require("src/descriptor.mjs");
const { createEditorModel, rebaseOverlay } = __require("src/editor/model.mjs");
const { buildRequest, callEndpoint, makeOperationId } = __require("ui/rpc.mjs");
const { annotationEdgePayload, annotationNodePayload, beginDrag, cancelDrag, commitDrag, coordinateMove, keyboardMove, makeAnnotationId, mergeOverlayItems, nodePosition, noteForTarget, notePayload, removeAnnotationNodePayload, removeAnnotationPayload, runEdit, updateDrag, visibilityPayload } = __require("ui/commands.mjs");
const { buildSvgScene, buildViewState } = __require("ui/view-model.mjs");
const { buildSaveInput, draftExportPlan } = __require("ui/xml-draft.mjs");
const { CONFLICT_OPTIONS, conflictView, describeOperationResult, describeSaveFailure, operationPollPlan, resolveConflict, SAVE_REASON_MESSAGES } = __require("ui/conflict.mjs");

const PANEL_CHANNEL = '/local-diagrams';

const OPEN_REASON_MESSAGES = Object.freeze({
  CONTEXT_UNBOUND: 'This document reference is not registered in any local scope.',
  SCOPE_REVOKED: 'The workspace scope changed. Reopen from a registered reference.',
  DOCUMENT_DENIED: 'This document is not registered for editing in the current scope.',
  OWNER_REQUIRED: 'The local editor channel requires the application owner session.',
  LIMIT_EXCEEDED: 'The document exceeds the local size limits.',
  INVALID_XML: 'The stored document XML is not valid.',
  INVALID_OVERLAY: 'The stored annotation overlay is not valid.',
  INTERNAL_FAILURE: 'The local editor failed unexpectedly.',
});

const EXPORT_REASON_MESSAGES = Object.freeze({
  EXPORT_EXISTS: 'A file with this name already exists in the output directory. Nothing was overwritten.',
  DOCUMENT_DENIED: 'The output directory is not registered for this scope.',
  STALE_VERSION: 'The document changed. Reopen before exporting.',
  UNSUPPORTED_FORMAT: 'This export format is not supported locally.',
  LIMIT_EXCEEDED: 'The export exceeds the local size limits.',
  INTERNAL_FAILURE: 'The local export failed unexpectedly.',
});

const styles = {
  root: { display: 'flex', flexDirection: 'column', gap: '8px', padding: '12px', height: '100%', boxSizing: 'border-box', overflow: 'auto', fontFamily: 'sans-serif', fontSize: '13px' },
  bar: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px' },
  card: { border: '1px solid #d0d7de', borderRadius: '6px', padding: '8px', background: '#ffffff' },
  muted: { color: '#57606a' },
  error: { color: '#b42318' },
  ok: { color: '#1a7f37' },
  row: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px' },
  input: { padding: '3px 6px', border: '1px solid #d0d7de', borderRadius: '4px', fontSize: '12px' },
  svgWrap: { border: '1px solid #d0d7de', borderRadius: '6px', background: '#fafbfc', overflow: 'auto', outline: 'none' },
  columns: { display: 'flex', gap: '12px', alignItems: 'flex-start', flexWrap: 'wrap' },
  sidebar: { width: '320px', minWidth: '280px', display: 'flex', flexDirection: 'column', gap: '8px' },
  list: { margin: 0, paddingLeft: '18px' },
};

/** @param {string} text @param {boolean} [danger] @returns {any} */
function message(text, danger = false) {
  return h('div', { style: danger ? styles.error : styles.muted }, text);
}

/** Small button factory. `key` is forwarded through createElement config. */
function button(props) {
  return h(
    'button',
    {
      key: props.key,
      type: 'button',
      onClick: props.onClick,
      disabled: props.disabled === true,
      title: props.title ?? props.label,
      style: {
        padding: '4px 10px',
        borderRadius: '4px',
        border: props.primary ? '1px solid #0969da' : '1px solid #d0d7de',
        background: props.primary ? '#0969da' : '#f6f8fa',
        color: props.primary ? '#ffffff' : '#1f2328',
        cursor: props.disabled === true ? 'not-allowed' : 'pointer',
        fontSize: '12px',
      },
    },
    props.label,
  );
}

/** Build the panel view state from the opened session + current editor model. */
function buildViewStateFor(session, model, selection) {
  return buildViewState({
    base_spec: session.base_spec,
    overlay: model.overlay,
    selection: selection === null ? [] : [selection],
    current_version: session.version,
    warnings: session.warnings,
  });
}

/** @param {any} scene @returns {any} React element tree; tags come from the whitelist. */
function renderScene(scene) {
  if (typeof scene === 'string') return scene;
  const children = (scene.children ?? []).map((child) => renderScene(child));
  return h(scene.tag, scene.attrs ?? {}, ...children);
}

/** Hit-test scene coordinates against visible nodes (topmost first). */
function hitTest(view, point) {
  const nodes = view?.nodes ?? [];
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index];
    if (node.hidden === true) continue;
    if (point.x >= node.x && point.x <= node.x + node.width && point.y >= node.y && point.y <= node.y + node.height) {
      return node.id;
    }
  }
  return null;
}

/** Convert a pointer event into scene coordinates. */
function scenePoint(event, svgElement, view) {
  const rect = typeof svgElement.getBoundingClientRect === 'function' ? svgElement.getBoundingClientRect() : null;
  const bounds = view?.bounds ?? { min_x: 0, min_y: 0, width: 1, height: 1 };
  if (rect === null || rect.width <= 0 || rect.height <= 0) {
    return { x: bounds.min_x + (event.clientX ?? 0), y: bounds.min_y + (event.clientY ?? 0) };
  }
  return {
    x: bounds.min_x + ((event.clientX - rect.left) / rect.width) * bounds.width,
    y: bounds.min_y + ((event.clientY - rect.top) / rect.height) * bounds.height,
  };
}

/** Local-only draft download; returns false in non-DOM environments. */
function downloadBlob(filename, mediaType, content) {
  if (typeof document === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return false;
  const blob = new Blob([content], { type: mediaType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  anchor.click();
  if (typeof URL.revokeObjectURL === 'function') setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}

/**
 * Panel component. Receives `{ctx}` from the slot wrapper created in `apply`.
 * @param {{ctx:any}} props
 * @returns {any}
 */
function LocalDiagramsPanel(props) {
  const transport = props?.ctx?.connection?.rpc;

  const [recent, setRecent] = useState([]);
  const [contextRef, setContextRef] = useState('');
  const [documentRef, setDocumentRef] = useState('');
  const [scopeGeneration, setScopeGeneration] = useState('0');
  const [outputRef, setOutputRef] = useState('');
  const [session, setSession] = useState(null);
  const [model, setModel] = useState(null);
  const [selection, setSelection] = useState(null);
  const [connectFrom, setConnectFrom] = useState(null);
  const [noteText, setNoteText] = useState('');
  const [annotationLabel, setAnnotationLabel] = useState('');
  const [addLabel, setAddLabel] = useState('');
  const [coordX, setCoordX] = useState('');
  const [coordY, setCoordY] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [conflict, setConflict] = useState(null);
  const [saveStatus, setSaveStatus] = useState('clean');
  const [operationView, setOperationView] = useState(null);
  const [preview, setPreview] = useState(null);
  const [exportStatus, setExportStatus] = useState(null);

  const viewEpochRef = useRef(0);
  const operationSeqRef = useRef(0);
  const commandSeqRef = useRef(0);
  const sessionRef = useRef(null);
  const modelRef = useRef(null);
  const activeRef = useRef(null);
  const dragRef = useRef(null);
  const abortRef = useRef(typeof AbortController === 'function' ? new AbortController() : null);
  const pollRef = useRef(null);
  const pendingSaveRef = useRef(null);
  const openEntryRef = useRef(null);

  sessionRef.current = session;
  modelRef.current = model;

  const nextOperationId = useCallback((prefix) => {
    operationSeqRef.current += 1;
    return makeOperationId(prefix, operationSeqRef.current);
  }, []);

  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => () => {
    stopPolling();
    if (abortRef.current && typeof abortRef.current.abort === 'function') abortRef.current.abort();
  }, [stopPolling]);

  const showNotice = useCallback((kind, text) => setNotice({ kind, text }), []);

  const storeActive = useCallback((entry, epoch) => {
    viewEpochRef.current = epoch;
    activeRef.current = {
      context_ref: entry.context_ref,
      expected_scope_generation: entry.expected_scope_generation,
      document_ref: entry.document_ref,
    };
  }, []);

  const beginDocument = useCallback((data, entry, epoch) => {
    const nextModel = createEditorModel(data.base_spec, data.overlay);
    storeActive(entry, epoch);
    setModel(nextModel);
    modelRef.current = nextModel;
    setSelection(null);
    setConflict(null);
    setSaveStatus('clean');
    setOperationView(null);
    setSession({
      document_id: data.document_id,
      base_spec: data.base_spec,
      overlay: data.overlay,
      version: data.version,
      editor_session_ref: data.editor_session_ref,
      warnings: data.warnings,
    });
    setContextRef(entry.context_ref);
    setDocumentRef(entry.document_ref);
    setScopeGeneration(String(entry.expected_scope_generation));
    setRecent((current) => {
      const filtered = current.filter(
        (item) => !(item.context_ref === entry.context_ref && item.document_ref === entry.document_ref),
      );
      return [{ ...entry }, ...filtered].slice(0, 8);
    });
  }, [storeActive]);

  const openEntry = useCallback(async (entry) => {
    if (!transport || busy) return;
    if (entry === null || entry === undefined) return;
    setBusy(true);
    setConflict(null);
    setOperationView(null);
    const epoch = viewEpochRef.current + 1;
    const requestResult = buildRequest({
      operation_id: nextOperationId('op-open'),
      context_ref: entry.context_ref,
      expected_scope_generation: entry.expected_scope_generation,
      view_epoch: epoch,
      input: { document_ref: entry.document_ref },
    });
    if (requestResult.ok !== true) {
      setBusy(false);
      showNotice('error', 'The document reference is not a valid registered reference.');
      return;
    }
    const interpreted = await callEndpoint(
      transport,
      'document.open',
      requestResult.request,
      abortRef.current?.signal,
      entry.expected_scope_generation,
    );
    setBusy(false);
    if (interpreted.kind === 'ok') {
      const data = interpreted.data;
      if (
        typeof data?.document_id !== 'string' ||
        typeof data?.base_spec !== 'object' ||
        data.base_spec === null ||
        typeof data?.overlay !== 'object' ||
        data.overlay === null ||
        typeof data?.version !== 'object' ||
        data.version === null ||
        typeof data?.editor_session_ref !== 'string'
      ) {
        showNotice('error', 'The local editor returned an unbalanced open payload.');
        return;
      }
      try {
        beginDocument(data, entry, epoch);
        showNotice('success', `Opened ${data.document_id} (${entry.document_ref}).`);
      } catch {
        showNotice('error', 'The opened document could not be prepared for editing.');
      }
      return;
    }
    if (interpreted.kind === 'business_failure') {
      const reason = OPEN_REASON_MESSAGES[interpreted.reason_code] ?? OPEN_REASON_MESSAGES.INTERNAL_FAILURE;
      showNotice('error', reason);
      return;
    }
    if (interpreted.kind === 'stale_epoch') return;
    showNotice('error', interpreted.message ?? OPEN_REASON_MESSAGES.INTERNAL_FAILURE);
  }, [beginDocument, busy, nextOperationId, showNotice, transport]);
  openEntryRef.current = openEntry;

  // 08 navigation adapter contract: validate the event detail and open through
  // the same Host-validated path. Never accepts XML/paths from the event.
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined;
    const onOpenEvent = (event) => {
      const validated = validateOpenEventDetail(event?.detail);
      if (validated.ok !== true) return;
      const handler = openEntryRef.current;
      if (typeof handler === 'function') handler(validated.intent);
    };
    window.addEventListener(OPEN_EVENT, onOpenEvent);
    return () => window.removeEventListener(OPEN_EVENT, onOpenEvent);
  }, []);

  /** Apply one local command through the editor model. */
  const applyEdit = useCallback((kind, payload) => {
    const current = modelRef.current;
    if (current === null) return { ok: false, code: 'NO_DOCUMENT' };
    commandSeqRef.current += 1;
    const result = runEdit({ model: current, kind, payload, sequence: commandSeqRef.current });
    if (result.status === 'ok') {
      setModel(result.model);
      modelRef.current = result.model;
      setSaveStatus((status) => (status === 'saving' ? status : 'dirty'));
      return { ok: true, model: result.model };
    }
    showNotice(
      'error',
      result.status === 'stale'
        ? 'A newer edit landed first; this command was ignored.'
        : 'The local editor rejected this edit. No change was made.',
    );
    return { ok: false, code: result.code ?? 'INVALID' };
  }, [showNotice]);

  const view = useMemo(() => {
    if (session === null || model === null) return null;
    return buildViewStateFor(session, model, selection);
  }, [session, model, selection]);

  const scene = useMemo(() => {
    if (view === null) return null;
    return buildSvgScene(view, { selected: selection, connect_from: connectFrom, preview });
  }, [view, selection, connectFrom, preview]);

  /* ------------------------------- pointer -------------------------------- */

  const onPointerDown = useCallback((event) => {
    if (view === null) return;
    const svgElement = event.currentTarget;
    const point = scenePoint(event, svgElement, view);
    const nodeId = hitTest(view, point);
    if (nodeId === null) {
      setSelection(null);
      return;
    }
    setSelection(nodeId);
    setNoteText(noteForTarget(modelRef.current, nodeId)?.text ?? '');
    setCoordX(String(Math.round(point.x)));
    setCoordY(String(Math.round(point.y)));
    if (connectFrom !== null && connectFrom !== nodeId) {
      commandSeqRef.current += 1;
      applyEdit('add_annotation_edge', annotationEdgePayload({
        id: makeAnnotationId('edge', commandSeqRef.current),
        from: connectFrom,
        to: nodeId,
        label: '',
      }));
      setConnectFrom(null);
      return;
    }
    const position = nodePosition(modelRef.current, nodeId, sessionRef.current?.base_spec);
    if (position === null) return;
    const dragResult = beginDrag({
      node_id: nodeId,
      pointer_id: event.pointerId ?? 0,
      position,
      client_x: point.x,
      client_y: point.y,
    });
    if (dragResult.ok !== true) return;
    dragRef.current = dragResult.drag;
    setPreview({ node_id: nodeId, x: position.x, y: position.y });
    if (typeof svgElement.setPointerCapture === 'function') {
      try {
        svgElement.setPointerCapture(event.pointerId);
      } catch {
        // pointer capture is best effort; pointerup still commits.
      }
    }
    if (typeof event.preventDefault === 'function') event.preventDefault();
  }, [applyEdit, connectFrom, view]);

  const onPointerMove = useCallback((event) => {
    const drag = dragRef.current;
    if (drag === null || view === null) return;
    const point = scenePoint(event, event.currentTarget, view);
    const next = updateDrag(drag, { client_x: point.x, client_y: point.y });
    setPreview({ node_id: drag.node_id, x: next.x, y: next.y });
  }, [view]);

  const onPointerUp = useCallback((event) => {
    const drag = dragRef.current;
    if (drag === null || view === null) return;
    dragRef.current = null;
    const point = scenePoint(event, event.currentTarget, view);
    const committed = commitDrag(drag, { client_x: point.x, client_y: point.y });
    setPreview(null);
    if (committed.ok !== true) return;
    applyEdit('move_node', committed.payload);
  }, [applyEdit, view]);

  const onPointerCancel = useCallback(() => {
    if (dragRef.current !== null) {
      cancelDrag(dragRef.current);
      dragRef.current = null;
    }
    setPreview(null);
  }, []);

  /* ------------------------------- keyboard ------------------------------- */

  const onKeyDown = useCallback((event) => {
    if (selection === null || sessionRef.current === null) return;
    const position = nodePosition(modelRef.current, selection, sessionRef.current.base_spec);
    if (position === null) return;
    const move = keyboardMove({ node_id: selection, position, key: event.key, shift: event.shiftKey === true });
    if (move.ok !== true) return;
    if (typeof event.preventDefault === 'function') event.preventDefault();
    applyEdit('move_node', move.payload);
  }, [applyEdit, selection]);

  /* ---------------------------------- open -------------------------------- */

  const openFromForm = useCallback(() => {
    const generation = Number.parseInt(scopeGeneration, 10);
    const entry = {
      context_ref: contextRef.trim(),
      document_ref: documentRef.trim(),
      expected_scope_generation: Number.isSafeInteger(generation) && generation >= 0 ? generation : 0,
    };
    if (entry.context_ref === '' || entry.document_ref === '') {
      showNotice('error', 'Enter a registered context ref and document ref.');
      return;
    }
    openEntry(entry);
  }, [contextRef, documentRef, openEntry, scopeGeneration, showNotice]);

  /* ---------------------------------- save -------------------------------- */

  const pollOperation = useCallback((operationRef) => {
    if (!transport || typeof operationRef !== 'string' || operationRef.length === 0) return;
    stopPolling();
    let attempts = 0;
    let inFlight = false;
    pollRef.current = setInterval(async () => {
      if (inFlight) return;
      const active = activeRef.current;
      if (active === null) {
        stopPolling();
        return;
      }
      const plan = operationPollPlan({ attempt: attempts, operation_ref: operationRef });
      if (plan.poll !== true) {
        stopPolling();
        return;
      }
      inFlight = true;
      attempts += 1;
      const requestResult = buildRequest({
        operation_id: nextOperationId('op-status'),
        context_ref: active.context_ref,
        expected_scope_generation: active.expected_scope_generation,
        view_epoch: viewEpochRef.current,
        input: { operation_ref: operationRef },
      });
      if (requestResult.ok !== true) {
        inFlight = false;
        stopPolling();
        return;
      }
      const interpreted = await callEndpoint(
        transport,
        'operation.get',
        requestResult.request,
        undefined,
        active.expected_scope_generation,
      );
      inFlight = false;
      if (interpreted.kind !== 'ok') return;
      const described = describeOperationResult(interpreted.data);
      setOperationView(described);
      if (described.state === 'saved' || described.state === 'failed') {
        stopPolling();
        if (described.state === 'saved' && described.recovered_version !== null) {
          setSession((current) => (current === null ? current : { ...current, version: described.recovered_version }));
          sessionRef.current = sessionRef.current === null
            ? sessionRef.current
            : { ...sessionRef.current, version: described.recovered_version };
          setSaveStatus('saved');
        } else {
          setSaveStatus('failed');
        }
      }
    }, 1000);
  }, [nextOperationId, stopPolling, transport]);

  const saveDocument = useCallback(async () => {
    if (!transport) {
      showNotice('error', 'The local editor channel is unavailable.');
      return;
    }
    const current = sessionRef.current;
    const currentModel = modelRef.current;
    const active = activeRef.current;
    if (current === null || currentModel === null || active === null) return;
    setBusy(true);
    setConflict(null);
    const built = buildSaveInput({
      document_id: current.document_id,
      editor_session_ref: current.editor_session_ref,
      expected_version: current.version,
      base_spec: current.base_spec,
      overlay: currentModel.overlay,
    });
    if (built.ok !== true) {
      setBusy(false);
      showNotice('error', SAVE_REASON_MESSAGES[built.code] ?? SAVE_REASON_MESSAGES.INTERNAL_FAILURE);
      return;
    }
    setSaveStatus('saving');
    const requestResult = buildRequest({
      operation_id: nextOperationId('op-save'),
      context_ref: active.context_ref,
      expected_scope_generation: active.expected_scope_generation,
      view_epoch: viewEpochRef.current,
      input: built.input,
    });
    if (requestResult.ok !== true) {
      setBusy(false);
      setSaveStatus('failed');
      showNotice('error', SAVE_REASON_MESSAGES.INVALID_REQUEST);
      return;
    }
    pendingSaveRef.current = requestResult.request.operation_id;
    const interpreted = await callEndpoint(
      transport,
      'document.save',
      requestResult.request,
      abortRef.current?.signal,
      active.expected_scope_generation,
    );
    setBusy(false);
    if (interpreted.kind === 'ok') {
      const version = interpreted.data?.version;
      if (typeof version?.generation !== 'number') {
        setSaveStatus('failed');
        showNotice('error', SAVE_REASON_MESSAGES.INTERNAL_FAILURE);
        return;
      }
      const nextSession = { ...current, version, overlay: currentModel.overlay };
      sessionRef.current = nextSession;
      setSession(nextSession);
      setSaveStatus('saved');
      showNotice('success', `Saved revision ${version.generation}.`);
      return;
    }
    if (interpreted.kind === 'business_failure') {
      const described = describeSaveFailure(interpreted);
      if (interpreted.status === 'conflict' && described.conflict !== null) {
        setConflict(conflictView({
          current_version: described.conflict.current_version,
          draft_ref: described.conflict.draft_ref,
          local_overlay: currentModel.overlay,
          document_id: current.document_id,
        }));
        setSaveStatus('conflict');
      } else if (interpreted.reason_code === 'OUTCOME_UNKNOWN' || interpreted.reason_code === 'CANCELLED') {
        setSaveStatus('unknown');
        setOperationView({ state: 'unknown', message: described.message, recovered_version: null });
        pollOperation(pendingSaveRef.current);
      } else {
        setSaveStatus('failed');
      }
      showNotice('error', described.message);
      return;
    }
    if (interpreted.kind === 'stale_epoch') {
      setSaveStatus('dirty');
      showNotice('error', 'A stale view response was ignored. Save again to confirm the current revision.');
      return;
    }
    // Transport failure / invalid envelope: the write outcome is unknown; poll
    // the operation record instead of blindly retrying.
    setSaveStatus('unknown');
    pollOperation(pendingSaveRef.current);
    showNotice('error', interpreted.message ?? SAVE_REASON_MESSAGES.OUTCOME_UNKNOWN);
  }, [nextOperationId, pollOperation, showNotice, transport]);

  /* ------------------------------- conflict ------------------------------- */

  const reopenWithLocalOverlay = useCallback(async (localOverlay) => {
    const active = activeRef.current;
    if (active === null || !transport) return false;
    const epoch = viewEpochRef.current + 1;
    const requestResult = buildRequest({
      operation_id: nextOperationId('op-reopen'),
      context_ref: active.context_ref,
      expected_scope_generation: active.expected_scope_generation,
      view_epoch: epoch,
      input: { document_ref: active.document_ref },
    });
    if (requestResult.ok !== true) return false;
    setBusy(true);
    const interpreted = await callEndpoint(
      transport,
      'document.open',
      requestResult.request,
      abortRef.current?.signal,
      active.expected_scope_generation,
    );
    setBusy(false);
    if (interpreted.kind !== 'ok') {
      showNotice('error', interpreted.message ?? OPEN_REASON_MESSAGES.INTERNAL_FAILURE);
      return false;
    }
    const data = interpreted.data;
    try {
      // Keep both: rebase the local draft onto the reopened Host base, then
      // merge the Host's current overlay items so neither side is lost. An
      // invalid merged composite falls back to the Host overlay only.
      const rebased = rebaseOverlay(data.base_spec, localOverlay);
      const mergedOverlay = {
        ...rebased.overlay,
        items: mergeOverlayItems(data.overlay, rebased.overlay),
      };
      /** @type {any} */
      let nextModel;
      try {
        nextModel = createEditorModel(data.base_spec, mergedOverlay);
      } catch {
        nextModel = createEditorModel(data.base_spec, data.overlay);
      }
      const nextSession = {
        document_id: data.document_id,
        base_spec: data.base_spec,
        overlay: nextModel.overlay,
        version: data.version,
        editor_session_ref: data.editor_session_ref,
        warnings: data.warnings,
      };
      viewEpochRef.current = epoch;
      setSession(nextSession);
      sessionRef.current = nextSession;
      setModel(nextModel);
      modelRef.current = nextModel;
      setConflict(null);
      setSaveStatus('dirty');
      showNotice(
        rebased.orphaned.length > 0 ? 'error' : 'info',
        rebased.orphaned.length > 0
          ? `${rebased.orphaned.length} annotation(s) lost their target and are preserved as orphaned.`
          : 'Local annotations were rebased and merged onto the current Host revision.',
      );
      return true;
    } catch {
      showNotice('error', 'The local annotations could not be rebased onto the current revision.');
      return false;
    }
  }, [nextOperationId, showNotice, transport]);

  const onConflictChoice = useCallback(async (choice) => {
    if (conflict === null || modelRef.current === null) return;
    const resolution = resolveConflict({
      choice,
      current_version: conflict.current_version,
      local: { overlay: modelRef.current.overlay },
    });
    if (resolution.ok !== true) {
      showNotice('error', SAVE_REASON_MESSAGES.STALE_VERSION);
      return;
    }
    if (resolution.action === 'download_draft') {
      const built = buildSaveInput({
        document_id: sessionRef.current?.document_id ?? '',
        editor_session_ref: sessionRef.current?.editor_session_ref ?? '',
        expected_version: sessionRef.current?.version,
        base_spec: sessionRef.current?.base_spec,
        overlay: modelRef.current.overlay,
      });
      if (built.ok !== true) {
        showNotice('error', SAVE_REASON_MESSAGES[built.code] ?? SAVE_REASON_MESSAGES.INTERNAL_FAILURE);
        return;
      }
      const plan = draftExportPlan({
        document_id: sessionRef.current?.document_id ?? '',
        generation: sessionRef.current?.version?.generation ?? 0,
        xml: built.xml,
        overlay: modelRef.current.overlay,
      });
      if (plan.ok !== true || !downloadBlob(plan.filename, plan.media_type, plan.content)) {
        showNotice('error', 'The local draft could not be downloaded in this environment.');
        return;
      }
      showNotice('success', `Draft ${plan.filename} downloaded locally.`);
      return;
    }
    const reopened = await reopenWithLocalOverlay(modelRef.current.overlay);
    if (reopened && resolution.action === 'reopen_then_resave') {
      // The Host keeps its conflicting revision immutable; saving the rebased
      // overlay as the next revision preserves both sides.
      await saveDocument();
    }
  }, [conflict, reopenWithLocalOverlay, saveDocument, showNotice]);

  /* -------------------------------- export -------------------------------- */

  const exportFormat = useCallback(async (format) => {
    if (!transport) return;
    const current = sessionRef.current;
    const active = activeRef.current;
    const output = outputRef.trim();
    if (current === null || active === null) return;
    if (output === '') {
      showNotice('error', 'Enter a registered output ref before exporting.');
      return;
    }
    setBusy(true);
    const requestResult = buildRequest({
      operation_id: nextOperationId('op-export'),
      context_ref: active.context_ref,
      expected_scope_generation: active.expected_scope_generation,
      view_epoch: viewEpochRef.current,
      input: { document_id: current.document_id, version: current.version, output_ref: output, format },
    });
    if (requestResult.ok !== true) {
      setBusy(false);
      showNotice('error', SAVE_REASON_MESSAGES.INVALID_REQUEST);
      return;
    }
    const interpreted = await callEndpoint(
      transport,
      'document.export',
      requestResult.request,
      abortRef.current?.signal,
      active.expected_scope_generation,
    );
    setBusy(false);
    if (interpreted.kind === 'ok') {
      const data = interpreted.data;
      if (typeof data?.artifact_ref !== 'string' || typeof data?.sha256 !== 'string') {
        showNotice('error', 'The local export returned an unbalanced payload.');
        return;
      }
      setExportStatus({ artifact_ref: data.artifact_ref, sha256: data.sha256, size_bytes: data.size_bytes });
      showNotice('success', `Exported ${data.artifact_ref} (${data.size_bytes} bytes).`);
      return;
    }
    if (interpreted.kind === 'business_failure') {
      showNotice('error', EXPORT_REASON_MESSAGES[interpreted.reason_code] ?? EXPORT_REASON_MESSAGES.INTERNAL_FAILURE);
      return;
    }
    showNotice('error', interpreted.message ?? EXPORT_REASON_MESSAGES.INTERNAL_FAILURE);
  }, [nextOperationId, outputRef, showNotice, transport]);

  /* --------------------------------- close -------------------------------- */

  const closeDocument = useCallback(async () => {
    const current = sessionRef.current;
    const active = activeRef.current;
    if (current !== null && transport && active !== null) {
      const requestResult = buildRequest({
        operation_id: nextOperationId('op-close'),
        context_ref: active.context_ref,
        expected_scope_generation: active.expected_scope_generation,
        view_epoch: viewEpochRef.current,
        input: { editor_session_ref: current.editor_session_ref },
      });
      if (requestResult.ok === true) {
        await callEndpoint(transport, 'session.close', requestResult.request, undefined, active.expected_scope_generation);
      }
    }
    stopPolling();
    viewEpochRef.current += 1;
    sessionRef.current = null;
    modelRef.current = null;
    setSession(null);
    setModel(null);
    setSelection(null);
    setConflict(null);
    setOperationView(null);
    setPreview(null);
    setSaveStatus('clean');
    showNotice('info', 'Editor session closed.');
  }, [nextOperationId, showNotice, stopPolling, transport]);

  /* ------------------------------- selection ------------------------------ */

  const onSelectChange = useCallback((event) => {
    const value = String(event?.target?.value ?? '');
    setSelection(value === '' ? null : value);
    setAnnotationLabel('');
    const current = modelRef.current;
    if (current !== null && value !== '') setNoteText(noteForTarget(current, value)?.text ?? '');
  }, []);

  const saveNote = useCallback(() => {
    if (selection === null) return;
    const current = modelRef.current;
    if (current === null) return;
    const existing = noteForTarget(current, selection);
    commandSeqRef.current += 1;
    const position = nodePosition(current, selection, sessionRef.current?.base_spec) ?? { x: 0, y: 0, width: 160, height: 64 };
    applyEdit('set_note', notePayload({
      annotation_id: existing?.id ?? makeAnnotationId('note', commandSeqRef.current),
      target_ref: selection,
      text: noteText,
      position: { x: position.x, y: position.y + position.height + 8, width: 200, height: 72 },
    }));
  }, [applyEdit, noteText, selection]);

  const addAnnotationNode = useCallback(() => {
    if (addLabel.trim() === '') {
      showNotice('error', 'Enter a label for the new annotation node.');
      return;
    }
    commandSeqRef.current += 1;
    const id = makeAnnotationId('node', commandSeqRef.current);
    const offset = (commandSeqRef.current % 6) * 24;
    const applied = applyEdit('add_annotation_node', annotationNodePayload({
      id,
      label: addLabel,
      description: null,
      position: { x: offset, y: offset, width: 160, height: 64 },
    }));
    setAddLabel('');
    if (applied.ok === true) setSelection(id);
  }, [addLabel, applyEdit, showNotice]);

  const startConnect = useCallback(() => {
    if (selection === null) return;
    setConnectFrom(selection);
    showNotice('info', 'Now click the target node to create one annotation edge.');
  }, [selection, showNotice]);

  const removeSelected = useCallback(() => {
    if (selection === null) return;
    const current = modelRef.current;
    if (current === null) return;
    const item = current.overlay.items.find((entry) => entry.id === selection);
    if (item === undefined) {
      const baseNodes = sessionRef.current?.base_spec?.nodes ?? [];
      if (baseNodes.some((node) => node.id === selection)) {
        applyEdit('set_visibility', visibilityPayload({ target_ref: selection, hidden: true }));
      }
      return;
    }
    if (item.kind === 'annotation_node') {
      applyEdit('remove_annotation_node', removeAnnotationNodePayload({ node_id: selection }));
    } else if (item.kind === 'note' || item.kind === 'annotation_edge') {
      applyEdit('remove_annotation', removeAnnotationPayload({ id: selection }));
    }
    setSelection(null);
  }, [applyEdit, selection]);

  const toggleSelectedVisibility = useCallback(() => {
    if (selection === null) return;
    const current = modelRef.current;
    if (current === null || sessionRef.current === null) return;
    const hidden = current.overlay.items.some(
      (item) => item.kind === 'visibility' && item.target_ref === selection && item.hidden === true,
    );
    applyEdit('set_visibility', visibilityPayload({ target_ref: selection, hidden: !hidden }));
  }, [applyEdit, selection]);

  const applyCoordinateForm = useCallback(() => {
    if (selection === null) return;
    const result = coordinateMove({ node_id: selection, x: coordX, y: coordY });
    if (result.ok !== true) {
      showNotice('error', 'Coordinates must be integers between -100000 and 100000.');
      return;
    }
    applyEdit('move_node', result.payload);
  }, [applyEdit, coordX, coordY, selection, showNotice]);

  const renameAnnotationNode = useCallback(() => {
    if (selection === null || annotationLabel.trim() === '') return;
    applyEdit('set_annotation_node', { id: selection, label: annotationLabel, description: null });
    setAnnotationLabel('');
  }, [annotationLabel, applyEdit, selection]);

  /* --------------------------------- render ------------------------------- */

  const selectedBaseSpec = session?.base_spec ?? null;
  const selectionOptions = view?.nodes?.map((node) => node.id) ?? [];

  function renderOpenForm() {
    return h('div', { style: styles.card }, [
      h('div', { key: 'heading', style: styles.row }, [
        h('strong', { key: 'a' }, 'Open a registered document'),
        h('span', { key: 'b', style: styles.muted }, 'Only registry references are accepted; the Host validates every open.'),
      ]),
      h('div', { key: 'form', style: styles.row }, [
        h('label', { key: 'c' }, [
          'context ref ',
          h('input', { style: styles.input, value: contextRef, onChange: (event) => setContextRef(String(event.target.value)), placeholder: 'ctx-demo' }),
        ]),
        h('label', { key: 'd' }, [
          'document ref ',
          h('input', { style: styles.input, value: documentRef, onChange: (event) => setDocumentRef(String(event.target.value)), placeholder: 'doc-demo' }),
        ]),
        h('label', { key: 'e' }, [
          'scope generation ',
          h('input', { style: styles.input, value: scopeGeneration, onChange: (event) => setScopeGeneration(String(event.target.value)), size: 4 }),
        ]),
        button({ key: 'f', label: busy ? 'Opening...' : 'Open', onClick: openFromForm, disabled: busy, primary: true }),
      ]),
      recent.length > 0
        ? h('div', { key: 'recent' }, [
            h('div', { key: 'h', style: styles.muted }, 'Recent (Host-validated) references'),
            h('ul', { key: 'list', style: styles.list }, recent.map((entry) => h(
              'li',
              { key: `${entry.context_ref}/${entry.document_ref}` },
              h('button', {
                type: 'button',
                style: { background: 'none', border: 'none', color: '#0969da', cursor: 'pointer', padding: 0 },
                onClick: () => openEntry(entry),
              }, `${entry.document_ref} | ${entry.context_ref}`),
            ))),
          ])
        : null,
    ]);
  }

  function renderWarnings() {
    const warnings = view?.warnings;
    if (warnings === undefined) return null;
    const lines = [];
    if (warnings.unresolved_count > 0) lines.push(`unresolved relations: ${warnings.unresolved_count}`);
    if (warnings.truncated === true) {
      lines.push(`truncated: omitted ${warnings.omitted_nodes} node(s) / ${warnings.omitted_edges} edge(s)`);
    }
    if (warnings.hidden_nodes > 0 || warnings.hidden_edges > 0) {
      lines.push(`hidden evidence: ${warnings.hidden_nodes} node(s) / ${warnings.hidden_edges} edge(s) hidden in this view; still counted in coverage`);
    }
    if (warnings.orphaned_annotations > 0) lines.push(`orphaned annotations preserved: ${warnings.orphaned_annotations}`);
    for (const storeWarning of warnings.store_warnings) lines.push(`store warning: ${storeWarning}`);
    if (lines.length === 0) return null;
    return h('div', { key: 'warnings', style: { ...styles.card, ...styles.row } }, lines.map((line, index) => h('span', { key: index }, line)));
  }

  function renderConflict() {
    return h('div', { key: 'conflict', style: { ...styles.card, borderColor: '#bf8700' } }, [
      h('div', { key: 'h' }, h('strong', {}, conflict.title)),
      h('div', { key: 'm', style: styles.muted }, conflict.message),
      h('div', { key: 'g', style: styles.muted }, `current Host revision: g${conflict.current_generation ?? '?'}`),
      conflict.draft_ref === null ? null : h('div', { key: 'd', style: styles.muted }, `Host draft ref: ${conflict.draft_ref}`),
      h('div', { key: 'row', style: styles.row }, CONFLICT_OPTIONS.map((option) => button({
        key: option.id,
        label: option.label,
        title: option.description,
        onClick: () => onConflictChoice(option.id),
        disabled: busy,
      }))),
    ]);
  }

  function renderEditor() {
    return h('div', { style: styles.columns }, [
      h('div', { key: 'main', style: { flex: '1 1 520px', minWidth: '360px', display: 'flex', flexDirection: 'column', gap: '8px' } }, [
        h('div', { key: 'sourcebar', style: { ...styles.card, ...styles.row } }, [
          h('span', { key: 'title' }, `${view?.title ?? 'Diagram'} | ${session?.document_id ?? ''}`),
          h('span', { key: 'gen', style: styles.muted }, `g${session?.version?.generation ?? 0}`),
          h('span', { key: 'sha', style: styles.muted }, `sha256 ${(session?.version?.content_sha256 ?? '').slice(0, 12)}`),
          h('span', { key: 'source', style: styles.muted }, `source_state: ${view?.source_state ?? 'unknown'}`),
        ]),
        renderWarnings(),
        h(
          'div',
          {
            key: 'svgwrap',
            style: styles.svgWrap,
            tabIndex: 0,
            onKeyDown,
            onPointerDown,
            onPointerMove,
            onPointerUp,
            onPointerCancel,
            title: 'Select a node, then drag. Arrow keys move 8 px (Shift 1 px).',
          },
          scene === null ? message('No scene.') : renderScene(scene),
        ),
        h('div', { key: 'text', style: styles.card }, [
          h('div', { key: 'h', style: styles.muted }, `Text equivalent (${view?.text_equivalent?.length ?? 0} entries)`),
          h('ul', { key: 'list', style: styles.list }, (view?.text_equivalent ?? []).slice(0, 200).map((entry) => h('li', { key: entry.id }, entry.text))),
        ]),
      ]),
      h('div', { key: 'side', style: styles.sidebar }, [
        h('div', { key: 'legend', style: styles.card }, [
          h('div', { key: 'h', style: styles.muted }, 'Certainty legend'),
          h('ul', { key: 'list', style: styles.list }, (view?.legend ?? []).map((entry) => h('li', { key: entry.kind }, `${entry.label}: ${entry.count}`))),
          h('div', { key: 'hidden', style: styles.muted }, `hidden evidence: ${view?.warnings?.hidden_nodes ?? 0} nodes / ${view?.warnings?.hidden_edges ?? 0} edges`),
          (view?.warnings?.orphaned_annotations ?? 0) > 0
            ? h('div', { key: 'orphan', style: styles.error }, `${view.warnings.orphaned_annotations} orphaned annotation(s) preserved`)
            : null,
        ]),
        h('div', { key: 'select', style: styles.card }, [
          h('div', { key: 'h', style: styles.muted }, 'Selection'),
          h('select', { style: styles.input, value: selection ?? '', onChange: onSelectChange }, [
            h('option', { key: 'none', value: '' }, 'none'),
            ...selectionOptions.map((id) => h('option', { key: id, value: id }, id)),
          ]),
          h('div', { key: 'row', style: styles.row }, [
            button({ key: 'connect', label: 'Connect from selected', onClick: startConnect, disabled: selection === null || busy }),
            button({ key: 'hide', label: 'Hide/show base entity', onClick: toggleSelectedVisibility, disabled: selection === null || busy }),
            button({ key: 'remove', label: 'Remove annotation', onClick: removeSelected, disabled: selection === null || busy }),
          ]),
        ]),
        h('div', { key: 'coords', style: styles.card }, [
          h('div', { key: 'h', style: styles.muted }, 'Move selected node (form fallback)'),
          h('div', { key: 'row', style: styles.row }, [
            h('label', { key: 'x' }, ['x ', h('input', { style: styles.input, value: coordX, onChange: (event) => setCoordX(String(event.target.value)), size: 7 })]),
            h('label', { key: 'y' }, ['y ', h('input', { style: styles.input, value: coordY, onChange: (event) => setCoordY(String(event.target.value)), size: 7 })]),
            button({ key: 'apply', label: 'Apply coordinates', onClick: applyCoordinateForm, disabled: selection === null || busy }),
          ]),
        ]),
        h('div', { key: 'note', style: styles.card }, [
          h('div', { key: 'h', style: styles.muted }, 'Note for selected node'),
          h('textarea', {
            key: 'text',
            style: { ...styles.input, width: '100%', minHeight: '54px' },
            value: noteText,
            onChange: (event) => setNoteText(String(event.target.value)),
            maxLength: 4096,
          }),
          button({ key: 'save', label: 'Save note', onClick: saveNote, disabled: selection === null || busy }),
        ]),
        h('div', { key: 'annotation', style: styles.card }, [
          h('div', { key: 'h', style: styles.muted }, 'Annotation node (conceptual diagrams only)'),
          h('div', { key: 'row', style: styles.row }, [
            h('input', { key: 'label', style: styles.input, value: addLabel, onChange: (event) => setAddLabel(String(event.target.value)), placeholder: 'label', maxLength: 256 }),
            button({ key: 'add', label: 'Add annotation node', onClick: addAnnotationNode, disabled: busy || (selectedBaseSpec?.mode ?? 'conceptual') !== 'conceptual' }),
          ]),
          h('div', { key: 'rename', style: styles.row }, [
            h('input', { key: 'label', style: styles.input, value: annotationLabel, onChange: (event) => setAnnotationLabel(String(event.target.value)), placeholder: 'new label for selected annotation node', maxLength: 256 }),
            button({ key: 'set', label: 'Relabel', onClick: renameAnnotationNode, disabled: selection === null || busy }),
          ]),
        ]),
        h('div', { key: 'export', style: styles.card }, [
          h('div', { key: 'h', style: styles.muted }, 'Export (registered output ref; exclusive create)'),
          h('div', { key: 'row', style: styles.row }, [
            h('input', { key: 'out', style: styles.input, value: outputRef, onChange: (event) => setOutputRef(String(event.target.value)), placeholder: 'out-demo' }),
            button({ key: 'drawio', label: '.drawio', onClick: () => exportFormat('drawio'), disabled: busy }),
            button({ key: 'json', label: 'JSON', onClick: () => exportFormat('json'), disabled: busy }),
            button({ key: 'svg', label: 'SVG', onClick: () => exportFormat('svg'), disabled: busy }),
          ]),
          exportStatus === null
            ? null
            : h('div', { key: 'status', style: styles.ok }, `exported ${exportStatus.artifact_ref} | ${exportStatus.size_bytes} bytes | sha256 ${exportStatus.sha256.slice(0, 16)}`),
        ]),
        conflict === null ? null : renderConflict(),
        operationView === null ? null : h('div', { key: 'op', style: styles.card }, [
          h('div', { key: 'h', style: styles.muted }, `Operation status: ${operationView.state}`),
          h('div', { key: 'm' }, operationView.message),
        ]),
      ]),
    ]);
  }

  function reopenFromActive() {
    const active = activeRef.current;
    if (active === null) return;
    openEntry({ ...active });
  }

  return h(
    'div',
    { style: styles.root, 'data-local-diagrams': 'panel' },
    h('div', { style: styles.bar }, [
      h('strong', { key: 'title' }, 'Local diagrams'),
      h('span', { key: 'mode', style: styles.muted }, session === null
        ? 'no document open'
        : `${view?.mode ?? 'diagram'} | ${view?.source_state ?? 'unknown'} | revision ${view?.generation ?? 0}`),
      ...(session === null
        ? []
        : [
            button({ key: 'save', label: 'Save', onClick: saveDocument, disabled: busy || saveStatus === 'saving', primary: true, title: 'Save with the exact expected version' }),
            button({ key: 'undo', label: 'Undo', onClick: () => applyEdit('undo', {}), disabled: busy }),
            button({ key: 'redo', label: 'Redo', onClick: () => applyEdit('redo', {}), disabled: busy }),
            button({ key: 'reload', label: 'Reopen', onClick: reopenFromActive, disabled: busy }),
            button({ key: 'close', label: 'Close', onClick: closeDocument, disabled: busy }),
          ]),
    ]),
    notice !== null ? message(notice.text, notice.kind === 'error') : null,
    session === null ? renderOpenForm() : renderEditor(),
  );
}

exports.PANEL_CHANNEL = PANEL_CHANNEL;
exports.LocalDiagramsPanel = LocalDiagramsPanel;
		};
		__definitions["ui/rpc.mjs"] = function (module, exports, __require) {
/**
 * Client-side RPC envelope helpers for the rc.5 connection channel.
 *
 * Frozen behaviour (docs/software-design.md §9 DIA-RPC-01):
 *  - `ctx.connection.rpc.call(channel, endpoint, payload, signal)` returns the
 *    RpcResult itself, NOT the business value. The client must check
 *    `result.ok === true` first and only then validate `result.value`.
 *  - A transport failure (`{ok:false,error}` or a malformed envelope) maps to the
 *    fixed `TRANSPORT_FAILURE`; the raw message/details are never displayed and
 *    a write is never retried automatically.
 *  - Business responses are validated against the closed union before any UI
 *    state is updated. A response carrying an older `view_epoch` than the
 *    request is `stale_epoch`: it is ignored instead of overwriting the current
 *    document.
 *  - Request shells are the strict closed union
 *    `{schema_version,operation_id,context_ref,expected_scope_generation,
 *    view_epoch,input}`.
 *
 * Pure module: no DOM globals, no network access; the transport is injected.
 */

/** The one channel owned by this plugin. */
const CHANNEL = '/local-diagrams';

const STATUSES = Object.freeze(['ok', 'denied', 'stale', 'invalid', 'conflict', 'unavailable', 'failed']);

/** Fixed reason codes the client accepts from the Host (mirror of the service). */
const REASON_CODES = Object.freeze([
  'OWNER_REQUIRED',
  'CONTEXT_UNBOUND',
  'SCOPE_REVOKED',
  'DOCUMENT_DENIED',
  'EDITOR_SESSION_EXPIRED',
  'STALE_VERSION',
  'INVALID_XML',
  'INVALID_OVERLAY',
  'LIMIT_EXCEEDED',
  'UNKNOWN_ENDPOINT',
  'INTERNAL_FAILURE',
  'INVALID_REQUEST',
  'OPERATION_CONFLICT',
  'EXPORT_EXISTS',
  'UNSUPPORTED_FORMAT',
  'OUTCOME_UNKNOWN',
  'CANCELLED',
]);

const STATUS_SET = new Set(STATUSES);
const REASON_SET = new Set(REASON_CODES);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+~=-]*$/u;
const REASON_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/u;

const OK_KEYS = Object.freeze(['schema_version', 'operation_id', 'view_epoch', 'scope_generation', 'status', 'data']);
const FAILURE_KEYS = Object.freeze(['schema_version', 'operation_id', 'view_epoch', 'scope_generation', 'status', 'reason_code']);

/** @param {unknown} value @returns {value is Record<string, any>} */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** @param {unknown} value @returns {boolean} */
function isId(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= 128 && ID_PATTERN.test(value);
}

/** @param {unknown} value @returns {boolean} */
function isCount(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * @param {Record<string, any>} value
 * @param {readonly string[]} keys
 * @returns {boolean}
 */
function hasExactKeys(value, keys) {
  const actual = Object.keys(value);
  if (actual.length !== keys.length) return false;
  return keys.every((key) => Object.hasOwn(value, key));
}

/**
 * Build and client-validate a request shell.
 * @param {{operation_id:string, context_ref:string, expected_scope_generation:number, view_epoch:number, input:Record<string, any>}} input
 * @returns {{ok:true, request:any} | {ok:false, errors:Array<{path:string,message:string}>}}
 */
function buildRequest(input) {
  /** @type {Array<{path:string,message:string}>} */
  const errors = [];
  if (!isRecord(input)) return { ok: false, errors: [{ path: '$', message: 'request input must be an object' }] };
  if (!isId(input.operation_id)) errors.push({ path: '$.operation_id', message: 'operation_id must be a 1-128 id' });
  if (!isId(input.context_ref)) errors.push({ path: '$.context_ref', message: 'context_ref must be a 1-128 id' });
  if (!isCount(input.expected_scope_generation)) {
    errors.push({ path: '$.expected_scope_generation', message: 'expected_scope_generation must be a non-negative integer' });
  }
  if (!isCount(input.view_epoch)) errors.push({ path: '$.view_epoch', message: 'view_epoch must be a non-negative integer' });
  if (!isRecord(input.input)) errors.push({ path: '$.input', message: 'input must be an object' });
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    request: {
      schema_version: 1,
      operation_id: input.operation_id,
      context_ref: input.context_ref,
      expected_scope_generation: input.expected_scope_generation,
      view_epoch: input.view_epoch,
      input: input.input,
    },
  };
}

/** Fixed, non-echoing description for {@link interpretRpcResult} transport failures. */
const TRANSPORT_FAILURE = Object.freeze({
  kind: 'transport_failure',
  code: 'TRANSPORT_FAILURE',
  message: 'The local editor channel is unavailable. No changes were applied.',
});

/**
 * Interpret one RpcResult for one request. Never throws, never echoes server
 * error text. The caller must not apply UI state for `transport_failure`,
 * `stale_epoch` or `invalid_response`.
 *
 * @param {unknown} result
 * @param {{request:any, expected_scope_generation:number}} expected
 * @returns {{kind:'ok', data:any, scope_generation:number} |
 *           {kind:'business_failure', status:string, reason_code:string, data?:any} |
 *           {kind:'transport_failure', code:string, message:string} |
 *           {kind:'stale_epoch'} |
 *           {kind:'invalid_response', code:string, message:string}}
 */
function interpretRpcResult(result, expected) {
  // A transport that resolves to anything but an RpcResult object is a
  // protocol-level failure; never inspect or display its contents.
  if (!isRecord(result)) return { ...TRANSPORT_FAILURE };
  if (result.ok !== true) {
    // `{ok:false,error:{code,message,details}}` from the Host transport layer;
    // the raw message/details are deliberately not surfaced.
    return { ...TRANSPORT_FAILURE };
  }
  const response = result.value;
  if (!isRecord(response)) return invalidResponse();
  if (response.schema_version !== 1) return invalidResponse();
  if (!isId(response.operation_id) || !isCount(response.view_epoch) || !isCount(response.scope_generation)) {
    return invalidResponse();
  }
  const request = expected?.request;
  if (!isRecord(request) || response.operation_id !== request.operation_id) return invalidResponse();
  if (response.scope_generation !== expected.expected_scope_generation) return invalidResponse();
  if (response.view_epoch < request.view_epoch) return { kind: 'stale_epoch' };
  if (response.view_epoch !== request.view_epoch) return invalidResponse();
  if (!STATUS_SET.has(response.status)) return invalidResponse();
  if (response.status === 'ok') {
    if (!hasExactKeys(response, OK_KEYS) || !isRecord(response.data)) return invalidResponse();
    return { kind: 'ok', data: response.data, scope_generation: response.scope_generation };
  }
  if (typeof response.reason_code !== 'string' || !REASON_PATTERN.test(response.reason_code)) {
    return invalidResponse();
  }
  if (!REASON_SET.has(response.reason_code)) return invalidResponse();
  if (response.status === 'conflict') {
    if (!hasExactKeys(response, FAILURE_KEYS) && Object.keys(response).length !== FAILURE_KEYS.length + 1) {
      return invalidResponse();
    }
    const extras = Object.keys(response).filter((key) => !FAILURE_KEYS.includes(key));
    if (extras.length > 1 || (extras.length === 1 && extras[0] !== 'data')) return invalidResponse();
    if (Object.hasOwn(response, 'data') && !isRecord(response.data)) return invalidResponse();
  } else if (!hasExactKeys(response, FAILURE_KEYS)) {
    return invalidResponse();
  }
  return {
    kind: 'business_failure',
    status: response.status,
    reason_code: response.reason_code,
    ...(Object.hasOwn(response, 'data') ? { data: response.data } : {}),
  };
}

/** @returns {{kind:'invalid_response', code:string, message:string}} */
function invalidResponse() {
  return {
    kind: 'invalid_response',
    code: 'INVALID_RESPONSE',
    message: 'The local editor channel returned an unexpected response. No changes were applied.',
  };
}

/**
 * Call one endpoint through an injected rc.5-style transport and interpret the
 * result. `transport.call` must have the `(channel, endpoint, payload, signal)`
 * signature; the returned promise resolves to the RpcResult.
 *
 * @param {{call:(channel:string, endpoint:string, payload:any, signal?:AbortSignal)=>Promise<any>}} transport
 * @param {string} endpoint
 * @param {any} request
 * @param {AbortSignal} [signal]
 * @param {number} [expectedScopeGeneration]
 * @returns {Promise<ReturnType<typeof interpretRpcResult>>}
 */
async function callEndpoint(transport, endpoint, request, signal, expectedScopeGeneration) {
  const expected = {
    request,
    expected_scope_generation:
      typeof expectedScopeGeneration === 'number'
        ? expectedScopeGeneration
        : isRecord(request)
          ? request.expected_scope_generation
          : 0,
  };
  /** @type {any} */
  let result;
  try {
    result = await transport.call(CHANNEL, endpoint, request, signal);
  } catch {
    // Transport throw (network/HTTP/rpcId mismatch): fixed failure, no retry.
    return { ...TRANSPORT_FAILURE };
  }
  return interpretRpcResult(result, expected);
}

/**
 * Deterministic unique operation ids for one editing session.
 * @param {string} prefix
 * @param {number} sequence
 * @returns {string}
 */
function makeOperationId(prefix, sequence) {
  const safePrefix = String(prefix).replace(/[^A-Za-z0-9_-]/gu, '-').slice(0, 48) || 'op';
  const id = `${safePrefix}-${String(sequence).padStart(6, '0')}`;
  return id.length <= 128 ? id : id.slice(0, 128);
}

/** @param {string} documentId @param {number} generation @param {string} format @returns {string} */
function exportFileName(documentId, generation, format) {
  const safeId = String(documentId).replace(/[^A-Za-z0-9_-]/gu, '-').slice(0, 64) || 'diagram';
  return `diagram-${safeId}-g${Math.max(0, Math.trunc(generation))}.${format}`;
}

exports.CHANNEL = CHANNEL;
exports.STATUSES = STATUSES;
exports.REASON_CODES = REASON_CODES;
exports.buildRequest = buildRequest;
exports.TRANSPORT_FAILURE = TRANSPORT_FAILURE;
exports.interpretRpcResult = interpretRpcResult;
exports.callEndpoint = callEndpoint;
exports.makeOperationId = makeOperationId;
exports.exportFileName = exportFileName;
		};
		__definitions["ui/view-model.mjs"] = function (module, exports, __require) {
/**
 * Pure view model + whitelisted SVG scene builder for the local editor panel.
 *
 * The panel is a view: this module turns the Host-provided canonical
 * `base_spec` and the local `AnnotationOverlayV1` into
 *  - a flat node/edge/note list with resolved positions, visibility, certainty
 *    and selection,
 *  - the source/version bar, certainty legend, unresolved/truncated warnings and
 *    hidden-count summary required by DIA-03/DIA-07,
 *  - a text-equivalent list,
 *  - a declarative SVG scene containing ONLY the whitelisted elements/attributes
 *    from docs/software-design.md §5 (`svg,g,rect,path,line,polyline,text,
 *    tspan,title,desc`). Labels are always text children, never attributes, and
 *    the panel renders each scene node with `createElement(tag)`, so React
 *    escapes all user text.
 *
 * No DOM globals at import time; everything is deterministic and Node-testable.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Whitelisted SVG element names (DIA-DESIGN-2 §5). */
const WHITELISTED_SVG_TAGS = Object.freeze([
  'svg',
  'g',
  'rect',
  'path',
  'line',
  'polyline',
  'text',
  'tspan',
  'title',
  'desc',
]);

/** Whitelisted presentation attributes; no href, style URL, on* or foreignObject. */
const SAFE_SVG_ATTRIBUTES = Object.freeze([
  'x',
  'y',
  'x1',
  'y1',
  'x2',
  'y2',
  'width',
  'height',
  'rx',
  'ry',
  'cx',
  'cy',
  'r',
  'd',
  'points',
  'fill',
  'fill-opacity',
  'stroke',
  'stroke-width',
  'stroke-dasharray',
  'font-size',
  'font-family',
  'font-weight',
  'text-anchor',
  'dominant-baseline',
  'dy',
  'transform',
  'opacity',
  'xmlns',
  'viewBox',
  'role',
  'aria-label',
]);

const TAG_SET = new Set(WHITELISTED_SVG_TAGS);
const ATTRIBUTE_SET = new Set(SAFE_SVG_ATTRIBUTES);

const CERTAINTY_COLORS = Object.freeze({
  exact: '#2e7d32',
  may: '#ef6c00',
  unresolved: '#c62828',
  unknown: '#757575',
});

const CERTAINTY_ORDER = Object.freeze(['exact', 'may', 'unresolved', 'unknown']);
const LEGEND_LABELS = Object.freeze({
  exact: 'exact evidence',
  may: 'may / inferred',
  unresolved: 'unresolved',
  unknown: 'annotation / unknown',
});

const DEFAULT_NODE_SIZE = Object.freeze({ width: 160, height: 64 });
const NODE_GAP = 32;

/** @param {unknown} value @returns {boolean} */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** @param {unknown} value @param {number} fallback @returns {number} */
function intOr(value, fallback) {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : fallback;
}

/** @param {string} label @param {number} maxChars @returns {string[]} */
function wrapLabel(label, maxChars = 22) {
  const text = String(label ?? '');
  if (text.length <= maxChars) return [text];
  const words = text.split(/\s+/u).filter((word) => word.length > 0);
  /** @type {string[]} */
  const lines = [];
  let current = '';
  for (const word of words) {
    if (current === '') {
      current = word;
    } else if (`${current} ${word}`.length <= maxChars) {
      current = `${current} ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
    while (current.length > maxChars) {
      lines.push(current.slice(0, maxChars));
      current = current.slice(maxChars);
    }
  }
  if (current !== '') lines.push(current);
  return lines.length === 0 ? [''] : lines;
}

/** @param {string} label @param {number} maxChars @returns {string} */
function truncateLabel(label, maxChars = 42) {
  const text = String(label ?? '');
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`;
}

/**
 * Resolve positions for every node/note of one document.
 * @param {any} spec
 * @param {any} overlay
 * @returns {{nodes:any[], hidden:Set<string>, layout:Map<string,any>}} sanitized
 */
function resolvePositions(spec, overlay) {
  /** @type {Map<string, any>} */
  const layout = new Map();
  for (const position of Array.isArray(spec?.layout?.positions) ? spec.layout.positions : []) {
    if (isRecord(position) && typeof position.node_id === 'string') layout.set(position.node_id, position);
  }
  const hidden = new Set();
  const items = Array.isArray(overlay?.items) ? overlay.items : [];
  for (const item of items) {
    if (item.kind === 'visibility' && item.hidden === true && typeof item.target_ref === 'string') hidden.add(item.target_ref);
    if (item.kind === 'layout' && isRecord(item.position) && typeof item.target_ref === 'string') {
      layout.set(item.target_ref, item.position);
    }
  }
  /** @type {any[]} */
  const nodes = [];
  for (const node of Array.isArray(spec?.nodes) ? spec.nodes : []) {
    const position = layout.get(node.id) ?? DEFAULT_NODE_SIZE;
    nodes.push({
      id: node.id,
      label: String(node.label ?? ''),
      kind: node.kind,
      origin: node.origin ?? 'evidence',
      evidence_count: Array.isArray(node.evidence_refs) ? node.evidence_refs.length : 0,
      annotation: false,
      hidden: hidden.has(node.id),
      x: intOr(position?.x, 0),
      y: intOr(position?.y, 0),
      width: intOr(position?.width, DEFAULT_NODE_SIZE.width),
      height: intOr(position?.height, DEFAULT_NODE_SIZE.height),
    });
  }
  for (const item of items) {
    if (item.kind !== 'annotation_node') continue;
    const position = item.position ?? DEFAULT_NODE_SIZE;
    nodes.push({
      id: item.id,
      label: String(item.label ?? ''),
      kind: 'note',
      origin: 'annotation',
      evidence_count: 0,
      annotation: true,
      hidden: false,
      x: intOr(position?.x, 0),
      y: intOr(position?.y, 0),
      width: intOr(position?.width, DEFAULT_NODE_SIZE.width),
      height: intOr(position?.height, DEFAULT_NODE_SIZE.height),
      description: item.description ?? null,
    });
  }
  return { nodes, hidden, layout };
}

/**
 * Build the full view state for one opened document.
 * @param {{base_spec:any, overlay:any, selection?:string[], current_version?:any, warnings?:string[]}} input
 * @returns {any}
 */
function buildViewState(input) {
  const spec = input?.base_spec;
  const overlay = input?.overlay;
  const selection = new Set(Array.isArray(input?.selection) ? input.selection : []);
  const { nodes, hidden } = resolvePositions(spec, overlay);
  const visibleNodeIds = new Set(nodes.filter((node) => node.hidden !== true).map((node) => node.id));

  /** @type {any[]} */
  const edges = [];
  for (const edge of Array.isArray(spec?.edges) ? spec.edges : []) {
    const hiddenEdge = hidden.has(edge.id) || hidden.has(edge.from) || hidden.has(edge.to);
    edges.push({
      id: edge.id,
      from: edge.from,
      to: edge.to,
      label: String(edge.label ?? ''),
      kind: edge.kind,
      certainty: edge.certainty ?? 'unknown',
      origin: edge.origin ?? 'evidence',
      annotation: false,
      hidden: hiddenEdge,
      visible: !hiddenEdge && visibleNodeIds.has(edge.from) && visibleNodeIds.has(edge.to),
      selected: selection.has(edge.id),
    });
  }
  const items = Array.isArray(overlay?.items) ? overlay.items : [];
  for (const item of items) {
    if (item.kind !== 'annotation_edge') continue;
    const visible = visibleNodeIds.has(item.from) && visibleNodeIds.has(item.to);
    edges.push({
      id: item.id,
      from: item.from,
      to: item.to,
      label: String(item.label ?? ''),
      kind: 'annotation',
      certainty: 'unknown',
      origin: 'annotation',
      annotation: true,
      hidden: false,
      visible,
      selected: selection.has(item.id),
    });
  }

  /** @type {any[]} */
  const notes = [];
  for (const item of items) {
    if (item.kind !== 'note') continue;
    const position = item.position ?? DEFAULT_NODE_SIZE;
    notes.push({
      id: item.id,
      target_ref: item.target_ref ?? null,
      text: String(item.text ?? ''),
      x: intOr(position?.x, 0),
      y: intOr(position?.y, 0),
      width: intOr(position?.width, DEFAULT_NODE_SIZE.width),
      height: intOr(position?.height, DEFAULT_NODE_SIZE.height),
      selected: selection.has(item.id),
    });
  }

  /** @type {Record<string, number>} */
  const certaintyCounts = {};
  for (const kind of CERTAINTY_ORDER) certaintyCounts[kind] = 0;
  for (const edge of edges) {
    if (edge.visible !== true) continue;
    const kind = CERTAINTY_ORDER.includes(edge.certainty) ? edge.certainty : 'unknown';
    certaintyCounts[kind] += 1;
  }
  const legend = CERTAINTY_ORDER.map((kind) => ({
    kind,
    label: LEGEND_LABELS[kind],
    count: certaintyCounts[kind],
    color: CERTAINTY_COLORS[kind],
  }));

  const coverage = isRecord(spec?.coverage) ? spec.coverage : {};
  const orphaned = Array.isArray(overlay?.orphaned_annotations) ? overlay.orphaned_annotations : [];
  const warnings = {
    unresolved_count: intOr(coverage.unresolved_count, 0),
    truncated: coverage.truncated === true,
    omitted_nodes: intOr(coverage.omitted_nodes, 0),
    omitted_edges: intOr(coverage.omitted_edges, 0),
    hidden_nodes: nodes.filter((node) => node.hidden === true).length,
    hidden_edges: edges.filter((edge) => edge.hidden === true && edge.annotation !== true).length,
    orphaned_annotations: orphaned.length,
    store_warnings: Array.isArray(input?.warnings) ? input.warnings.slice(0, 16) : [],
  };

  /** @type {any[]} */
  const textEquivalent = [];
  for (const node of nodes) textEquivalent.push({ id: node.id, text: `node: ${node.label}` });
  for (const edge of edges) {
    if (edge.visible !== true) continue;
    const source = nodes.find((node) => node.id === edge.from);
    const target = nodes.find((node) => node.id === edge.to);
    textEquivalent.push({
      id: edge.id,
      text: `${source?.label ?? edge.from} -${edge.label === '' ? '' : `[${edge.label}]`}-> ${target?.label ?? edge.to} (${edge.certainty})`,
    });
  }
  for (const note of notes) textEquivalent.push({ id: note.id, text: `note: ${note.text}` });

  const xs = nodes.map((node) => [node.x, node.x + node.width]).flat();
  const ys = nodes.map((node) => [node.y, node.y + node.height]).flat();
  const minX = xs.length > 0 ? Math.min(...xs) : 0;
  const minY = ys.length > 0 ? Math.min(...ys) : 0;
  const maxX = xs.length > 0 ? Math.max(...xs) : 1;
  const maxY = ys.length > 0 ? Math.max(...ys) : 1;
  const padding = 40;
  const bounds = {
    min_x: minX - padding,
    min_y: minY - padding,
    max_x: maxX + padding,
    max_y: maxY + padding,
    width: Math.max(1, maxX - minX + padding * 2),
    height: Math.max(1, maxY - minY + padding * 2),
  };

  return {
    diagram_id: spec?.diagram_id ?? null,
    title: String(spec?.title ?? 'Untitled diagram'),
    mode: spec?.mode ?? 'conceptual',
    source_state: spec?.source_state ?? 'unknown',
    generated_at: spec?.generated_at ?? null,
    renderer_ref: spec?.renderer_ref ?? null,
    revision: intOr(spec?.revision, 0),
    document_id: input?.current_version?.document_id ?? null,
    generation: intOr(input?.current_version?.generation, 0),
    content_sha256: typeof input?.current_version?.content_sha256 === 'string' ? input.current_version.content_sha256 : null,
    nodes: nodes.map((node) => ({ ...node, selected: selection.has(node.id) })),
    edges,
    notes,
    legend,
    warnings,
    text_equivalent: textEquivalent,
    bounds,
  };
}

/* -------------------------------------------------------------------------- */
/* whitelisted SVG scene                                                       */
/* -------------------------------------------------------------------------- */

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function asRecord(value) {
  return isRecord(value);
}

/**
 * Assert that a scene only contains whitelisted tags/attributes. Throws a coded
 * error instead of ever rendering an unsafe element.
 * @param {any} scene
 * @returns {any} scene
 */
function assertSafeScene(scene) {
  if (!asRecord(scene) || !TAG_SET.has(scene.tag)) {
    throw new Error('SVG scene contains a non-whitelisted element');
  }
  for (const key of Object.keys(scene.attrs ?? {})) {
    if (!ATTRIBUTE_SET.has(key)) throw new Error(`SVG scene attribute "${key}" is not whitelisted`);
  }
  for (const child of Array.isArray(scene.children) ? scene.children : []) {
    if (typeof child === 'string') continue;
    if (Array.isArray(child)) {
      for (const nested of child) assertSafeScene(nested);
      continue;
    }
    assertSafeScene(child);
  }
  return scene;
}

/** @param {number} value @returns {number} */
function round(value) {
  return Math.round(value);
}

/** @param {string} text @param {number} max @returns {string} */
function clip(text, max) {
  return truncateLabel(text, max);
}

/**
 * Build the whitelisted SVG scene for a view state.
 * @param {any} view
 * @param {{width?:number, height?:number, selected?:string|null, connect_from?:string|null, preview?:{node_id:string,x:number,y:number}|null}} [options]
 * @returns {any} `{tag:'svg', attrs, children}`
 */
function buildSvgScene(view, options = {}) {
  const bounds = view?.bounds ?? { width: 800, height: 600, min_x: -40, min_y: -40 };
  const width = Math.max(1, intOr(options.width, bounds.width));
  const height = Math.max(1, intOr(options.height, bounds.height));
  const nodeById = new Map((view?.nodes ?? []).map((node) => [node.id, node]));
  const selected = typeof options.selected === 'string' ? options.selected : null;
  const connectFrom = typeof options.connect_from === 'string' ? options.connect_from : null;
  const preview = isRecord(options.preview) && typeof options.preview.node_id === 'string' ? options.preview : null;

  /** @param {any} node @returns {{x:number,y:number}} */
  const nodePositionOf = (node) => {
    if (preview !== null && preview.node_id === node.id) {
      return { x: intOr(preview.x, node.x), y: intOr(preview.y, node.y) };
    }
    return { x: node.x, y: node.y };
  };

  /** @type {any[]} */
  const children = [];

  // Edges first so nodes draw above them.
  for (const edge of view?.edges ?? []) {
    if (edge.visible !== true) continue;
    const source = nodeById.get(edge.from);
    const target = nodeById.get(edge.to);
    if (source === undefined || target === undefined) continue;
    const color = CERTAINTY_COLORS[edge.certainty] ?? CERTAINTY_COLORS.unknown;
    const dash = edge.certainty === 'exact' ? undefined : '6 4';
    const sourcePoint = nodePositionOf(source);
    const targetPoint = nodePositionOf(target);
    const x1 = round(sourcePoint.x + source.width / 2);
    const y1 = round(sourcePoint.y + source.height / 2);
    const x2 = round(targetPoint.x + target.width / 2);
    const y2 = round(targetPoint.y + target.height / 2);
    children.push({
      tag: 'line',
      attrs: { x1, y1, x2, y2, stroke: color, 'stroke-width': 2, ...(dash === undefined ? {} : { 'stroke-dasharray': dash }) },
      children: [],
    });
    // Small fixed arrowhead path (path is whitelisted; no marker/defs).
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const size = 8;
    const path = [
      `M ${x2} ${y2}`,
      `L ${round(x2 - size * Math.cos(angle - Math.PI / 6))} ${round(y2 - size * Math.sin(angle - Math.PI / 6))}`,
      `L ${round(x2 - size * Math.cos(angle + Math.PI / 6))} ${round(y2 - size * Math.sin(angle + Math.PI / 6))}`,
      'Z',
    ].join(' ');
    children.push({ tag: 'path', attrs: { d: path, fill: color, stroke: 'none' }, children: [] });
    const midX = round((x1 + x2) / 2);
    const midY = round((y1 + y2) / 2) - 6;
    children.push({
      tag: 'text',
      attrs: { x: midX, y: midY, 'font-size': 11, 'text-anchor': 'middle', fill: color, 'font-family': 'sans-serif' },
      children: [clip(edge.label, 42)],
    });
    children.push({ tag: 'title', attrs: {}, children: [`${edge.label || edge.id} (${edge.certainty})`] });
  }

  // Notes render above edges but below nodes.
  for (const note of view?.notes ?? []) {
    const isSelected = selected === note.id;
    children.push({
      tag: 'g',
      attrs: { transform: `translate(${note.x} ${note.y})` },
      children: [
        {
          tag: 'rect',
          attrs: {
            x: 0,
            y: 0,
            width: note.width,
            height: note.height,
            rx: 4,
            fill: '#fff2cc',
            stroke: isSelected ? '#1a73e8' : '#d6b656',
            'stroke-width': isSelected ? 3 : 1,
          },
          children: [],
        },
        {
          tag: 'text',
          attrs: { x: 8, y: 20, 'font-size': 12, fill: '#333333', 'font-family': 'sans-serif' },
          children: wrapLabel(note.text, 28).slice(0, 3),
        },
      ],
    });
  }

  for (const node of view?.nodes ?? []) {
    if (node.hidden === true) continue;
    const isSelected = selected === node.id;
    const isConnectSource = connectFrom === node.id;
    const stroke = isSelected || isConnectSource ? '#1a73e8' : node.annotation ? '#9673a6' : '#6c8ebf';
    const fill = node.annotation ? '#e1d5e7' : '#dae8fc';
    /** @type {any[]} */
    const texts = wrapLabel(node.label, 22)
      .slice(0, 3)
      .map((line, index) => ({
        tag: 'tspan',
        attrs: { x: 10, ...(index === 0 ? { dy: 0 } : { dy: 14 }) },
        children: [line],
      }));
    const rendered = nodePositionOf(node);
    children.push({
      tag: 'g',
      attrs: { transform: `translate(${rendered.x} ${rendered.y})` },
      children: [
        {
          tag: 'rect',
          attrs: {
            x: 0,
            y: 0,
            width: node.width,
            height: node.height,
            rx: 6,
            fill,
            stroke,
            'stroke-width': isSelected || isConnectSource ? 3 : 1,
            opacity: node.origin === 'evidence' ? 1 : 0.95,
          },
          children: [],
        },
        {
          tag: 'text',
          attrs: { x: 0, y: 22, 'font-size': 12, fill: '#1b1b1b', 'font-family': 'sans-serif', 'dominant-baseline': 'middle' },
          children: texts,
        },
        { tag: 'title', attrs: {}, children: [`${node.label} [${node.kind}${node.annotation ? ', annotation' : ''}]`] },
      ],
    });
  }

  const scene = {
    tag: 'svg',
    attrs: {
      xmlns: SVG_NS,
      viewBox: `${bounds.min_x} ${bounds.min_y} ${width} ${height}`,
      width,
      height,
      role: 'img',
      'aria-label': `Diagram: ${clip(view?.title ?? 'diagram', 120)}`,
    },
    children: [{ tag: 'title', attrs: {}, children: [clip(view?.title ?? 'diagram', 160)] }, ...children],
  };
  return assertSafeScene(scene);
}

/**
 * Rendering attributes for the panel's `<svg>` wrapper (from the same scene
 * contract, so the panel cannot drift into unsafe attributes).
 * @param {any} scene
 * @returns {Record<string, any>}
 */
function svgAttributes(scene) {
  assertSafeScene(scene);
  return { ...scene.attrs };
}

exports.SVG_NS = SVG_NS;
exports.WHITELISTED_SVG_TAGS = WHITELISTED_SVG_TAGS;
exports.SAFE_SVG_ATTRIBUTES = SAFE_SVG_ATTRIBUTES;
exports.CERTAINTY_COLORS = CERTAINTY_COLORS;
exports.CERTAINTY_ORDER = CERTAINTY_ORDER;
exports.LEGEND_LABELS = LEGEND_LABELS;
exports.DEFAULT_NODE_SIZE = DEFAULT_NODE_SIZE;
exports.NODE_GAP = NODE_GAP;
exports.wrapLabel = wrapLabel;
exports.truncateLabel = truncateLabel;
exports.buildViewState = buildViewState;
exports.assertSafeScene = assertSafeScene;
exports.buildSvgScene = buildSvgScene;
exports.svgAttributes = svgAttributes;
		};
		__definitions["ui/xml-draft.mjs"] = function (module, exports, __require) {
/**
 * Client-side save XML assembly + draft export plans (ui/xml-draft.mjs).
 *
 * The Host never trusts client XML: `document.save` re-parses it against the
 * restricted drawio whitelist and compares its canonical semantics with XML it
 * regenerates from its own base spec + the submitted overlay. To make that
 * comparison succeed, the client builds its XML with the SAME deterministic
 * exporter the Host uses (`src/drawio/xml.mjs#exportDrawio`, inlined by
 * tools/build-client.mjs), never by hand-concatenating strings.
 *
 * This module is pure; the browser download of a draft is performed by the
 * panel from the plan returned by {@link draftExportPlan}.
 */

const { exportDrawio } = __require("src/drawio/xml.mjs");

/**
 * Build the canonical save XML for the current local overlay.
 * @param {{base_spec:any, overlay:any}} input
 * @returns {{ok:true, xml:string, warnings:string[]} | {ok:false, code:string}}
 */
function buildSaveXml(input) {
  try {
    const exported = exportDrawio({
      spec: input?.base_spec,
      annotation_overlay: input?.overlay,
    });
    const warnings = Array.isArray(exported?.warnings)
      ? exported.warnings.filter((entry) => typeof entry === 'string').slice(0, 16)
      : [];
    return { ok: true, xml: String(exported.xml), warnings };
  } catch (error) {
    const code = typeof error?.code === 'string' ? error.code : 'INTERNAL_FAILURE';
    const fixed = ['INVALID_SPEC', 'INVALID_OVERLAY', 'LIMIT_EXCEEDED', 'UNSUPPORTED'].includes(code)
      ? code
      : 'INTERNAL_FAILURE';
    return { ok: false, code: fixed };
  }
}

/**
 * Byte length of the UTF-8 save XML (host cap is 10 MiB by default).
 * @param {string} xml
 * @returns {number}
 */
function xmlByteLength(xml) {
  if (typeof xml !== 'string') return 0;
  if (typeof TextEncoder === 'function') return new TextEncoder().encode(xml).length;
  if (typeof Buffer !== 'undefined' && typeof Buffer.byteLength === 'function') return Buffer.byteLength(xml, 'utf8');
  let bytes = 0;
  for (let index = 0; index < xml.length; index += 1) {
    const code = xml.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * Build the `document.save` endpoint input for one open session.
 * @param {{document_id:string, editor_session_ref:string, expected_version:any, base_spec:any, overlay:any}} input
 * @returns {{ok:true, input:any, xml:string, warnings:string[]} | {ok:false, code:string}}
 */
function buildSaveInput(input) {
  const built = buildSaveXml({ base_spec: input?.base_spec, overlay: input?.overlay });
  if (built.ok !== true) return built;
  return {
    ok: true,
    warnings: built.warnings,
    xml: built.xml,
    input: {
      document_id: input.document_id,
      editor_session_ref: input.editor_session_ref,
      expected_version: input.expected_version,
      xml: built.xml,
      overlay: input.overlay,
    },
  };
}

/**
 * Plan the local "export draft" download for a save conflict. The Host already
 * keeps a drafts copy when it detects the conflict (draft_ref); this plan makes
 * the user's local edits downloadable too. No network, no host write.
 *
 * @param {{document_id:string, generation?:number, xml:string, overlay:any}} input
 * @returns {{ok:true, filename:string, media_type:string, content:string} | {ok:false, code:string}}
 */
function draftExportPlan(input) {
  if (typeof input?.document_id !== 'string' || input.document_id.length === 0) {
    return { ok: false, code: 'INVALID_REQUEST' };
  }
  if (typeof input?.xml !== 'string' || !input.xml.startsWith('<mxfile')) {
    return { ok: false, code: 'INVALID_XML' };
  }
  const generation = Number.isSafeInteger(input.generation) && input.generation >= 0 ? input.generation : 0;
  const safeId = input.document_id.replace(/[^A-Za-z0-9_-]/gu, '-').slice(0, 64) || 'diagram';
  const payload = {
    schema_version: 1,
    kind: 'local-diagrams-draft',
    document_id: input.document_id,
    generation,
    xml: input.xml,
    overlay: input.overlay ?? null,
  };
  return {
    ok: true,
    filename: `diagram-${safeId}-g${generation}-draft.json`,
    media_type: 'application/json',
    content: JSON.stringify(payload, null, 2),
  };
}

/**
 * Plan a JSON export payload from an opened document (client-side preview only;
 * the authoritative export goes through `document.export`).
 * @param {{document_id:string, version:any, base_spec:any, overlay:any}} input
 * @returns {{ok:true, filename:string, media_type:string, content:string}}
 */
function jsonExportPlan(input) {
  const generation = Number.isSafeInteger(input?.version?.generation) ? input.version.generation : 0;
  const safeId = String(input?.document_id ?? 'diagram').replace(/[^A-Za-z0-9_-]/gu, '-').slice(0, 64) || 'diagram';
  return {
    ok: true,
    filename: `diagram-${safeId}-g${generation}.json`,
    media_type: 'application/json',
    content: JSON.stringify(
      {
        schema_version: 1,
        document_id: input?.document_id ?? null,
        version: input?.version ?? null,
        base_spec: input?.base_spec ?? null,
        overlay: input?.overlay ?? null,
      },
      null,
      2,
    ),
  };
}

exports.buildSaveXml = buildSaveXml;
exports.xmlByteLength = xmlByteLength;
exports.buildSaveInput = buildSaveInput;
exports.draftExportPlan = draftExportPlan;
exports.jsonExportPlan = jsonExportPlan;
		};
		function __require(id) {
			if (Object.prototype.hasOwnProperty.call(__definitions, id)) {
				if (Object.prototype.hasOwnProperty.call(__cache, id)) return __cache[id];
				var target = { exports: {} };
				__definitions[id](target, target.exports, __require);
				__cache[id] = target.exports;
				return target.exports;
			}
			return require(id);
		}
		module.exports = __require("ui/client-entry.mjs");
		return module.exports;
	}
});
