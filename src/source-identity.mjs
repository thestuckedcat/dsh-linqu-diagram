/**
 * Source-identity root references.
 *
 * DIA-DESIGN-2 carries `SourceIdentityV1.repos[].root_ref` as a *source
 * reference*, not a file-access grant. This project stores/returns it as an
 * opaque `root-ref:<16 hex>` identity derived from the registered scope, repo
 * and raw root, so generated specs, artifacts and RPC responses never persist a
 * local filesystem path. Identity comparison (source-state.mjs) does not compare
 * root_ref by design; the digest exists so a spec/event can still name the same
 * repo root without exposing it (independent review R-09).
 */
import { canonicalJson, sha256Hex } from './canonical.mjs';

/**
 * @param {string} scopeRef
 * @param {string} repoId
 * @param {string} rawRootRef
 * @returns {string} `root-ref:<16 hex>` (idempotent for already-opaque values)
 */
export function rootRefIdentity(scopeRef, repoId, rawRootRef) {
  const raw = typeof rawRootRef === 'string' ? rawRootRef : '';
  if (/^root-ref:[0-9a-f]{16}$/u.test(raw)) return raw;
  return `root-ref:${sha256Hex(canonicalJson({ scope_ref: scopeRef, repo_id: repoId, root_ref: raw })).slice(0, 16)}`;
}

/** @param {unknown} value */
export function isOpaqueRootRef(value) {
  return typeof value === 'string' && /^root-ref:[0-9a-f]{16}$/u.test(value);
}
