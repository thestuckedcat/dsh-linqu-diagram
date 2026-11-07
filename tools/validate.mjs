#!/usr/bin/env node
/**
 * 06 local diagrams: schema/fixture validation CLI.
 *
 * Checks (all offline, no third-party dependency):
 *  1. every schemas/*.json parses and the authoritative JS schemas in
 *     src/contracts.mjs are byte-equivalent to the JSON artifacts;
 *  2. fixture source identities and generated diagram specs/overlays validate
 *     against the authoritative schemas;
 *  3. the semantic composite invariants hold for a spec+empty overlay;
 *  4. the malicious-label fixture escapes to inert text (no markup opener,
 *     no control characters survive XML escaping).
 *
 * Prints a JSON report and exits non-zero when any check fails.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_SCHEMAS, SCHEMA_FILES, validateDiagramSpec, validateSourceIdentity, validateOverlay, validateComposite, emptyOverlay, specDigest } from '../src/contracts.mjs';
import { toDiagram } from '../src/evidence.mjs';
import { escXml } from '../src/render-svg.mjs';
import { canonicalJson } from '../src/canonical.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_ROOT = path.join(PROJECT_ROOT, 'tests', 'fixtures');
const FIXTURE_CLOCK = '2026-11-07T00:00:00.000Z';

/** @param {string} filePath */
async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

/** @param {string} label @param {() => any} check */
async function runCheck(label, check) {
  try {
    const value = await check();
    if (value === undefined || value === true) return { name: label, ok: true };
    if (value === false) return { name: label, ok: false, errors: [{ message: 'check returned false' }] };
    return { name: label, ok: true, detail: value };
  } catch (error) {
    return { name: label, ok: false, errors: [{ message: String(error?.message ?? error) }] };
  }
}

/** @param {string} label @param {{ok:boolean, errors?:any[]}} result */
function fromResult(label, result) {
  return result.ok ? { name: label, ok: true } : { name: label, ok: false, errors: result.errors ?? [] };
}

async function main() {
  /** @type {{name:string, ok:boolean, errors?:any[], detail?:any}[]} */
  const checks = [];

  checks.push(
    await runCheck('schemas.json_parse', async () => {
      /** @type {object[]} */
      const errors = [];
      for (const [name, relativePath] of Object.entries(SCHEMA_FILES)) {
        const schemaPath = path.join(PROJECT_ROOT, relativePath);
        let parsed;
        try {
          parsed = await readJson(schemaPath);
        } catch (error) {
          errors.push({ schema: name, message: String(error.message) });
          continue;
        }
        if (parsed.type !== 'object') errors.push({ schema: name, message: 'schema root must be type object' });
        if (!('$schema' in parsed)) errors.push({ schema: name, message: 'missing $schema' });
      }
      if (errors.length > 0) return { ok: false, errors };
      return { ok: true };
    }),
  );

  checks.push(
    await runCheck('schemas.js_matches_json', async () => {
      /** @type {object[]} */
      const errors = [];
      for (const [name, relativePath] of Object.entries(SCHEMA_FILES)) {
        const fromJson = await readJson(path.join(PROJECT_ROOT, relativePath));
        const fromJs = ALL_SCHEMAS[name];
        if (fromJs === undefined) {
          errors.push({ schema: name, message: 'contracts.mjs has no such schema' });
          continue;
        }
        if (canonicalJson(fromJson) !== canonicalJson(fromJs)) {
          errors.push({ schema: name, message: 'JS schema differs from schemas/*.json artifact' });
        }
      }
      if (errors.length > 0) return { ok: false, errors };
      return { ok: true };
    }),
  );

  checks.push(
    await runCheck('fixtures.source_identity', async () => {
      const errors = [];
      for (const name of ['source-identity.json']) {
        const identity = await readJson(path.join(FIXTURE_ROOT, 'snapshot', name));
        const result = validateSourceIdentity(identity);
        if (!result.ok) errors.push({ fixture: name, errors: result.errors });
      }
      if (errors.length > 0) return { ok: false, errors };
      return { ok: true };
    }),
  );

  /** @type {{spec:any} | null} */
  let snapshotBuild = null;
  checks.push(
    await runCheck('fixtures.evidence_to_spec', async () => {
      const sourceIdentity = await readJson(path.join(FIXTURE_ROOT, 'snapshot', 'source-identity.json'));
      const evidenceSubset = await readJson(path.join(FIXTURE_ROOT, 'snapshot', 'evidence-subset.json'));
      const currentIdentities = await readJson(path.join(FIXTURE_ROOT, 'snapshot', 'current-identities.json'));
      const result = toDiagram(
        { source_identity: sourceIdentity, evidence_subset: evidenceSubset, current_identities: currentIdentities },
        { clock: () => FIXTURE_CLOCK, revision: 1, direction: 'LR' },
      );
      if (result.status !== 'ok') return { ok: false, errors: result.errors ?? [{ message: result.code }] };
      const validation = validateDiagramSpec(result.spec);
      if (!validation.ok) return { ok: false, errors: validation.errors };
      snapshotBuild = { spec: result.spec };
      return { ok: true, detail: { diagram_id: result.spec.diagram_id, nodes: result.spec.nodes.length, edges: result.spec.edges.length } };
    }),
  );

  checks.push(
    await runCheck('fixtures.conceptual_to_spec', async () => {
      const conceptualInput = await readJson(path.join(FIXTURE_ROOT, 'conceptual', 'input.json'));
      const result = toDiagram({ conceptual_input: conceptualInput }, { clock: () => FIXTURE_CLOCK, revision: 1, direction: 'LR' });
      if (result.status !== 'ok') return { ok: false, errors: result.errors ?? [{ message: result.code }] };
      const validation = validateDiagramSpec(result.spec);
      if (!validation.ok) return { ok: false, errors: validation.errors };
      return { ok: true };
    }),
  );

  if (snapshotBuild !== null) {
    const snapshotSpec = /** @type {{spec:any}} */ (snapshotBuild).spec;
    checks.push(
      await runCheck('fixtures.empty_overlay_and_composite', async () => {
        const overlay = emptyOverlay({ diagram_id: snapshotSpec.diagram_id, base_spec_digest: specDigest(snapshotSpec), now: FIXTURE_CLOCK });
        const overlayCheck = validateOverlay(overlay);
        if (!overlayCheck.ok) return { ok: false, errors: overlayCheck.errors };
        const composite = validateComposite(snapshotSpec, overlay);
        if (!composite.ok) return { ok: false, errors: composite.errors };
        return { ok: true };
      }),
    );
  }

  checks.push(
    await runCheck('malicious.labels_escape_to_text', async () => {
      const payloads = await readJson(path.join(FIXTURE_ROOT, 'malicious', 'payloads.json'));
      const labels = Array.isArray(payloads.labels) ? payloads.labels : [];
      const errors = [];
      for (const label of labels) {
        const escaped = escXml(label);
        if (/[<>"]/.test(escaped)) errors.push({ label, message: 'escaped output still contains markup-significant characters' });
        if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(escaped)) errors.push({ label, message: 'control characters survived escaping' });
      }
      if (errors.length > 0) return { ok: false, errors };
      return { ok: true, detail: { labels: labels.length } };
    }),
  );

  const failed = checks.filter((check) => check.ok !== true);
  const report = {
    schema_version: 1,
    command: 'node tools/validate.mjs',
    ok: failed.length === 0,
    total: checks.length,
    pass: checks.length - failed.length,
    fail: failed.length,
    skip: 0,
    checks,
    limitations: ['schema/fixture validation only; no browser rendering or Host RPC is exercised'],
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

main().catch((error) => {
  process.stdout.write(`${JSON.stringify({ schema_version: 1, command: 'node tools/validate.mjs', ok: false, fail: 1, error: String(error?.message ?? error) }, null, 2)}\n`);
  process.exitCode = 2;
});

