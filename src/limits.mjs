/**
 * 06 local diagrams — engineering limits.
 *
 * These are the v1 resource defaults frozen by DIA-DESIGN-2 §4/§7. They are
 * engineering values chosen to bound memory and XML attack surface, not user
 * performance requirements. Tests exercise both sides of each boundary.
 */
export const LIMITS = Object.freeze({
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
export const CODES = Object.freeze({
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
