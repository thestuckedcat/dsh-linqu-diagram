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

import { exportDrawio } from '../src/drawio/xml.mjs';

/**
 * Build the canonical save XML for the current local overlay.
 * @param {{base_spec:any, overlay:any}} input
 * @returns {{ok:true, xml:string, warnings:string[]} | {ok:false, code:string}}
 */
export function buildSaveXml(input) {
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
export function xmlByteLength(xml) {
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
export function buildSaveInput(input) {
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
export function draftExportPlan(input) {
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
export function jsonExportPlan(input) {
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
