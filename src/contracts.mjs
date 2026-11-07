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
import { validateSchema } from './schema.mjs';
import { canonicalJson, sha256Hex } from './canonical.mjs';
import { LIMITS, CODES } from './limits.mjs';
import { fail } from './errors.mjs';

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

export const PATTERNS = Object.freeze({
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

export const SCHEMAS = Object.freeze({
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
export const ADDITIONAL_SCHEMAS = Object.freeze({
  source_lock: withSchemaUri(sourceLockSchema()),
  editor_command: withSchemaUri(editorCommandSchema()),
});

export const ALL_SCHEMAS = Object.freeze({ ...SCHEMAS, ...ADDITIONAL_SCHEMAS });

/** Logical schema name -> authoritative JSON artifact path (relative to project root). */
export const SCHEMA_FILES = Object.freeze({
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
export function validateSourceIdentity(value) {
  return validateAgainst(SCHEMAS.source_identity, value);
}

/** @param {unknown} value */
export function validateEvidenceRef(value) {
  return validateAgainst(SCHEMAS.evidence_ref, value);
}

/** @param {unknown} value */
export function validateDiagramSpec(value) {
  return validateAgainst(SCHEMAS.diagram_spec, value, specSemantics);
}

/** @param {unknown} value */
export function validateOverlay(value) {
  return validateAgainst(SCHEMAS.annotation_overlay, value, overlaySemantics);
}

/** @param {unknown} value */
export function validateManifest(value) {
  return validateAgainst(SCHEMAS.artifact_manifest, value);
}

/** @param {unknown} value */
export function validateDocumentVersion(value) {
  return validateAgainst(SCHEMAS.document_version, value);
}

/** @param {unknown} value */
export function validateAccessRegistry(value) {
  return validateAgainst(SCHEMAS.access_registry, value);
}

/** @param {unknown} value */
export function validateEditorModel(value) {
  return validateAgainst(SCHEMAS.editor_model, value);
}

/** @param {unknown} value */
export function validateRpcRequest(value) {
  return validateAgainst(SCHEMAS.rpc_request, value);
}

/** @param {unknown} value */
export function validateRpcResponse(value) {
  return validateAgainst(SCHEMAS.rpc_response, value);
}

/** @param {unknown} value */
export function validateSourceLock(value) {
  return validateAgainst(ALL_SCHEMAS.source_lock, value);
}

/** @param {unknown} value */
export function validateEditorCommand(value) {
  return validateAgainst(ALL_SCHEMAS.editor_command, value);
}

/**
 * Cross-object invariants for base spec + annotation overlay (DIA-OVERLAY-01).
 *
 * @param {unknown} spec
 * @param {unknown} overlay
 * @returns {{ok:true, value:{spec:any, overlay:any}} | {ok:false, errors: ContractIssue[]}}
 */
export function validateComposite(spec, overlay) {
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
export function specDigest(spec) {
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
export function overlayDigest(overlay) {
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
export function manifestDigest(manifest) {
  const result = validateManifest(manifest);
  if (!result.ok) fail(CODES.INVALID_MANIFEST, 'cannot digest an invalid artifact manifest', { errors: result.errors });
  return sha256Hex(canonicalJson(result.value));
}

/**
 * @param {unknown} version
 * @returns {string}
 */
export function documentVersionDigest(version) {
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
export function text(value, maxLength = LIMITS.label, name = 'text') {
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
export function id(value, maxLength = ID_MAX, name = 'id') {
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
export function utcTimestamp(value, name = 'timestamp') {
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
export function sha256HexValue(value, name = 'digest') {
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
export function rendererRefValue(value, name = 'renderer_ref') {
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
export function emptyOverlay(options) {
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
export const PATTERNS_EXTRA = Object.freeze({
  media_type: MEDIA_TYPE_REGEX.source,
  relative_path: RELATIVE_PATH_REGEX.source,
  renderer_ref: RENDERER_REF_REGEX.source,
});

/** Editor command union kinds, in schema order. */
export const EDITOR_COMMAND_KIND_LIST = EDITOR_COMMAND_KINDS;
