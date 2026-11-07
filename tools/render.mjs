#!/usr/bin/env node
/**
 * 06 local diagrams — offline render CLI (T2 acceptance surface).
 *
 * Usage:
 *   node tools/render.mjs --fixture [--conceptual] [--renderer builtin] [--out DIR]
 *   node tools/render.mjs --evidence <subset.json> --source-identity <identity.json>
 *                         [--current-identities <identity.json|array.json>]
 *                         [--scope-ref T] [--title T] [--diagram-id ID] [--revision N]
 *                         [--renderer builtin] [--out DIR]
 *   node tools/render.mjs --conceptual <input.json> [overrides...] [--out DIR]
 *
 * The CLI reads only local files (URL/UNC paths are rejected), pipes the input
 * through src/evidence.mjs toDiagram -> layout -> renderLocal (builtin), writes
 * an immutable artifact package under --out only, verifies it (resource
 * manifest, offline HTML policy, zero remote references, 7 files) and prints a
 * single JSON summary. It never opens a network connection.
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createArchive, artifactFileNames } from '../src/archive.mjs';
import { buildResourceManifest, verifyResourceManifest, verifyAtlasArtifact, offlinePolicy } from '../src/assets.mjs';
import { canonicalJson, sha256Hex } from '../src/canonical.mjs';
import { emptyOverlay, specDigest, validateDiagramSpec } from '../src/contracts.mjs';
import { toDiagram } from '../src/evidence.mjs';
import { LIMITS } from '../src/limits.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_ROOT = path.join(PROJECT_ROOT, 'tests', 'fixtures');
/** Fixed clock keeps fixture artifact bytes reproducible across runs. */
const FIXTURE_CLOCK = '2026-11-07T00:00:00.000Z';
const REMOTE_REF_PATTERN = /https?:\/\//gi;

const USAGE = `usage:
  node tools/render.mjs --fixture [--conceptual] [--renderer builtin] [--out DIR]
  node tools/render.mjs --evidence <path> --source-identity <path> [--current-identities <path>]
                        [--scope-ref <text>] [--title <text>] [--diagram-id <id>]
                        [--revision <n>] [--renderer builtin] [--out DIR]
  node tools/render.mjs --conceptual <path> [overrides...] [--renderer builtin] [--out DIR]
flags:
  --fixture              render the synthetic snapshot fixture (deterministic fixed clock)
  --evidence <path>      local EvidenceSubset JSON file (evidence mode, needs --source-identity)
  --source-identity <p>  local SourceIdentityV1 JSON file
  --current-identities <p> local SourceIdentityV1 or array JSON (source_state current/stale/unknown)
  --conceptual <path>    local conceptual input JSON file (title/scope_ref/nodes/edges)
  --scope-ref/--title/--diagram-id/--revision  optional spec overrides
  --renderer builtin     only the builtin renderer is available
  --out <dir>            output root for the immutable artifact package (default ./scratch-output)`;

class CliError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** @param {string} value @param {string} label */
function assertLocalPath(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new CliError('INVALID_INPUT', `${label} requires a local file path`);
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(value)) {
    throw new CliError('INVALID_INPUT', `${label} must be a local file path; URL schemes are rejected`);
  }
  if (/^(?:file|https?|wss?|ftps?|data|blob|about|javascript):/iu.test(value)) {
    throw new CliError('INVALID_INPUT', `${label} must be a local file path; URL schemes are rejected`);
  }
  if (value.startsWith('//') || value.startsWith('\\\\')) {
    throw new CliError('INVALID_INPUT', `${label} must not be a UNC/network path`);
  }
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw new CliError('INVALID_INPUT', `${label} contains control characters`);
  }
  return value;
}

/**
 * Parse CLI arguments into a validated option object.
 * @param {string[]} argv
 * @returns {any}
 */
export function parseArgs(argv) {
  const options = {
    fixture: false,
    fixtureConceptual: false,
    evidencePath: null,
    sourceIdentityPath: null,
    currentIdentitiesPath: null,
    conceptualPath: null,
    scopeRef: null,
    title: null,
    diagramId: null,
    revision: null,
    renderer: 'builtin',
    out: './scratch-output',
    help: false,
  };
  /** @param {number} index @param {string} flag */
  const takeValue = (index, flag) => {
    if (index >= argv.length || argv[index].startsWith('--')) {
      throw new CliError('INVALID_INPUT', `${flag} requires a value`);
    }
    return argv[index];
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--fixture') options.fixture = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--conceptual') {
      if (index + 1 < argv.length && !argv[index + 1].startsWith('--')) {
        index += 1;
        options.conceptualPath = argv[index];
      } else {
        options.fixtureConceptual = true;
      }
    } else if (argument === '--evidence') {
      index += 1;
      options.evidencePath = takeValue(index, '--evidence');
    } else if (argument === '--source-identity') {
      index += 1;
      options.sourceIdentityPath = takeValue(index, '--source-identity');
    } else if (argument === '--current-identities') {
      index += 1;
      options.currentIdentitiesPath = takeValue(index, '--current-identities');
    } else if (argument === '--scope-ref') {
      index += 1;
      options.scopeRef = takeValue(index, '--scope-ref');
    } else if (argument === '--title') {
      index += 1;
      options.title = takeValue(index, '--title');
    } else if (argument === '--diagram-id') {
      index += 1;
      options.diagramId = takeValue(index, '--diagram-id');
    } else if (argument === '--revision') {
      index += 1;
      const raw = takeValue(index, '--revision');
      const revision = Number(raw);
      if (!Number.isSafeInteger(revision) || revision < 0) throw new CliError('INVALID_INPUT', '--revision must be a non-negative integer');
      options.revision = revision;
    } else if (argument === '--renderer') {
      index += 1;
      options.renderer = takeValue(index, '--renderer');
    } else if (argument.startsWith('--renderer=')) {
      options.renderer = argument.slice('--renderer='.length);
    } else if (argument === '--out') {
      index += 1;
      options.out = takeValue(index, '--out');
    } else if (argument.startsWith('--out=')) {
      options.out = argument.slice('--out='.length);
    } else {
      throw new CliError('INVALID_INPUT', `unknown argument: ${argument}`);
    }
  }
  if (options.help) return options;
  const modeCount = [options.fixture, options.conceptualPath !== null, options.evidencePath !== null].filter(Boolean).length;
  if (modeCount !== 1) {
    throw new CliError('INVALID_INPUT', 'exactly one of --fixture, --conceptual <path>, --evidence <path> is required');
  }
  if (options.fixtureConceptual && !options.fixture) {
    throw new CliError('INVALID_INPUT', 'flag-only --conceptual is only meaningful together with --fixture');
  }
  if ((options.sourceIdentityPath !== null || options.currentIdentitiesPath !== null) && options.evidencePath === null) {
    throw new CliError('INVALID_INPUT', '--source-identity/--current-identities are only valid with --evidence');
  }
  if (
    options.evidencePath === null &&
    options.conceptualPath === null &&
    (options.scopeRef !== null || options.title !== null || options.diagramId !== null || options.revision !== null)
  ) {
    throw new CliError('INVALID_INPUT', 'spec overrides are only valid with --evidence or --conceptual <path>');
  }
  return options;
}

/** @param {string} filePath @param {string} label */
async function readLocalJson(filePath, label) {
  const resolved = path.resolve(process.cwd(), assertLocalPath(filePath, label));
  let stats;
  try {
    stats = await stat(resolved);
  } catch {
    throw new CliError('INVALID_INPUT', `${label} file does not exist: ${filePath}`);
  }
  if (!stats.isFile()) throw new CliError('INVALID_INPUT', `${label} is not a regular file: ${filePath}`);
  if (stats.size > LIMITS.rpc_json_bytes) throw new CliError('LIMIT_EXCEEDED', `${label} exceeds ${LIMITS.rpc_json_bytes} bytes`);
  let text;
  try {
    text = await readFile(resolved, 'utf8');
  } catch {
    throw new CliError('INVALID_INPUT', `${label} is not readable: ${filePath}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new CliError('INVALID_INPUT', `${label} is not valid JSON: ${filePath}`);
  }
}

/** @param {string} filePath */
async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

/** @param {object} options @returns {Record<string, any>} */
function specOverrides(options) {
  const policy = {};
  if (options.title !== null) policy.title = options.title;
  if (options.diagramId !== null) policy.diagram_id = options.diagramId;
  if (options.revision !== null) policy.revision = options.revision;
  return policy;
}

/** @param {any} spec @param {object} options */
function applyScopeRef(spec, options) {
  if (options.scopeRef === null) return spec;
  const next = { ...spec, scope_ref: options.scopeRef };
  const check = validateDiagramSpec(next);
  if (!check.ok) throw new CliError('INVALID_SPEC', '--scope-ref produced an invalid diagram spec');
  return next;
}

/** @param {object} options */
async function buildFixtureSpec(options) {
  const clock = () => FIXTURE_CLOCK;
  if (options.fixtureConceptual) {
    const conceptualInput = await readJson(path.join(FIXTURE_ROOT, 'conceptual', 'input.json'));
    const result = toDiagram({ conceptual_input: conceptualInput }, { clock, revision: 1, direction: 'LR' });
    if (result.status !== 'ok') throw new CliError(result.code ?? 'INVALID_SPEC', 'fixture conceptual input failed to produce a spec');
    return { spec: result.spec, outputRef: 'fixture', operationId: 'render-fixture-conceptual' };
  }
  const sourceIdentity = await readJson(path.join(FIXTURE_ROOT, 'snapshot', 'source-identity.json'));
  const evidenceSubset = await readJson(path.join(FIXTURE_ROOT, 'snapshot', 'evidence-subset.json'));
  const currentIdentities = await readJson(path.join(FIXTURE_ROOT, 'snapshot', 'current-identities.json'));
  const result = toDiagram(
    { source_identity: sourceIdentity, evidence_subset: evidenceSubset, current_identities: currentIdentities },
    { clock, revision: 1, direction: 'LR' },
  );
  if (result.status !== 'ok') throw new CliError(result.code ?? 'INVALID_SPEC', 'fixture evidence subset failed to produce a spec');
  return { spec: result.spec, outputRef: 'fixture', operationId: 'render-fixture-snapshot' };
}

/** @param {object} options */
async function buildEvidenceSpec(options) {
  if (options.sourceIdentityPath === null) {
    throw new CliError('INVALID_INPUT', '--source-identity <path> is required with --evidence');
  }
  const evidenceSubset = await readLocalJson(options.evidencePath, '--evidence');
  const sourceIdentity = await readLocalJson(options.sourceIdentityPath, '--source-identity');
  const input = { source_identity: sourceIdentity, evidence_subset: evidenceSubset };
  if (options.currentIdentitiesPath !== null) input.current_identities = await readLocalJson(options.currentIdentitiesPath, '--current-identities');
  const result = toDiagram(input, { ...specOverrides(options), clock: () => new Date().toISOString() });
  if (result.status !== 'ok') {
    throw new CliError(result.code ?? 'INVALID_SPEC', 'evidence subset failed to produce a valid diagram spec');
  }
  const spec = applyScopeRef(result.spec, options);
  const operationId = `render-evidence-${sha256Hex(canonicalJson({
    evidence_subset: evidenceSubset,
    source_identity: sourceIdentity,
    current_identities: input.current_identities ?? null,
    overrides: { scope_ref: options.scopeRef, title: options.title, diagram_id: options.diagramId, revision: options.revision },
  })).slice(0, 16)}`;
  return { spec, outputRef: 'evidence', operationId };
}

/** @param {object} options */
async function buildConceptualSpec(options) {
  const conceptualInput = await readLocalJson(options.conceptualPath, '--conceptual');
  const result = toDiagram({ conceptual_input: conceptualInput }, { ...specOverrides(options), clock: () => new Date().toISOString() });
  if (result.status !== 'ok') {
    throw new CliError(result.code ?? 'INVALID_SPEC', 'conceptual input failed to produce a valid diagram spec');
  }
  const spec = applyScopeRef(result.spec, options);
  const operationId = `render-conceptual-${sha256Hex(canonicalJson({
    conceptual_input: conceptualInput,
    overrides: { scope_ref: options.scopeRef, title: options.title, diagram_id: options.diagramId, revision: options.revision },
  })).slice(0, 16)}`;
  return { spec, outputRef: 'conceptual', operationId };
}

/** @param {any} spec */
function warningsForSpec(spec) {
  const warnings = [];
  if (spec.coverage && spec.coverage.complete === false) warnings.push('coverage.complete=false：v1 固定不承诺全仓完整。');
  if (spec.coverage && spec.coverage.truncated === true) {
    const nodes = Number.isSafeInteger(spec.coverage.omitted_nodes) ? spec.coverage.omitted_nodes : 0;
    const edges = Number.isSafeInteger(spec.coverage.omitted_edges) ? spec.coverage.omitted_edges : 0;
    warnings.push(`coverage.truncated=true：省略节点 ${nodes} 个、边 ${edges} 条。`);
  }
  if (spec.coverage && Number.isSafeInteger(spec.coverage.unresolved_count) && spec.coverage.unresolved_count > 0) {
    warnings.push(`unresolved_count=${spec.coverage.unresolved_count}：unresolved 边不是 exact。`);
  }
  if (spec.source_state === 'stale') warnings.push('source_state=stale：源快照与当前登记身份不一致，旧定位不能当作当前已验证。');
  if (spec.source_state === 'unknown') warnings.push('source_state=unknown：缺少当前登记身份，不能当作当前快照。');
  return warnings;
}

/** @param {string} artifactRef @param {string} outputRoot */
async function inspectArtifact(artifactRef, outputRoot) {
  const names = artifactFileNames();
  /** @type {string[]} */ const warnings = [];
  const files = await readdir(artifactRef);
  if (files.length !== names.length) warnings.push(`artifact 文件数 ${files.length} != ${names.length}`);
  const resourceBuild = await buildResourceManifest(names, { root: artifactRef });
  if (!resourceBuild.ok) warnings.push('resource manifest 重建失败');
  let manifestCheck = { ok: false, errors: [] };
  const remoteHits = [];
  for (const name of names) {
    const text = (await readFile(path.join(artifactRef, name))).toString('utf8');
    const matches = text.match(REMOTE_REF_PATTERN);
    if (matches !== null) remoteHits.push({ file: name, count: matches.length });
  }
  try {
    const manifest = JSON.parse(await readFile(path.join(artifactRef, 'manifest.json'), 'utf8'));
    manifestCheck = verifyResourceManifest(manifest, { root: artifactRef });
  } catch {
    warnings.push('manifest.json 不可读');
  }
  const offlineHtml = await verifyAtlasArtifact(path.join(artifactRef, 'index.html'), { allowed_root: outputRoot });
  if (!manifestCheck.ok) warnings.push('manifest 校验失败');
  if (!offlineHtml.ok) warnings.push('离线 HTML 校验失败');
  if (remoteHits.length > 0) warnings.push('artifact 中存在远程引用');
  const ok = files.length === names.length && resourceBuild.ok && manifestCheck.ok && offlineHtml.ok && remoteHits.length === 0;
  return {
    ok,
    checks: {
      files: files.length,
      expected_files: names.length,
      resource_manifest: resourceBuild.ok,
      manifest_verify: manifestCheck.ok,
      offline_html: offlineHtml.ok,
      remote_refs: remoteHits.length,
    },
    warnings,
  };
}

/** Build the always-complete summary object (required keys never missing). @param {object} values */
function summaryOf(values) {
  return {
    schema_version: 1,
    command: 'node tools/render.mjs',
    status: values.status ?? 'failed',
    mode: values.mode ?? null,
    renderer: values.renderer ?? null,
    source_state: values.source_state ?? null,
    nodes: Number.isSafeInteger(values.nodes) ? values.nodes : 0,
    edges: Number.isSafeInteger(values.edges) ? values.edges : 0,
    truncated: values.truncated === true,
    artifact_ref: values.artifact_ref ?? null,
    manifest_digest: values.manifest_digest ?? null,
    warnings: Array.isArray(values.warnings) ? values.warnings : [],
    ...(values.code ? { code: values.code } : {}),
    ...(values.checks ? { checks: values.checks } : {}),
    exit_code: values.exit_code ?? 1,
  };
}

/**
 * Run the CLI without process-level side effects (unit-testable).
 * @param {string[]} argv
 * @returns {Promise<{summary?:object, helpText?:string, exitCode:number}>}
 */
export async function runRender(argv = []) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    const code = error instanceof CliError ? error.code : 'INVALID_INPUT';
    return { summary: summaryOf({ status: 'failed', code, warnings: [String(error.message)], exit_code: 1 }), exitCode: 1 };
  }
  if (options.help) return { helpText: USAGE, exitCode: 0 };
  if (options.renderer !== 'builtin') {
    return {
      summary: summaryOf({
        status: 'failed',
        renderer: options.renderer,
        code: 'UNSUPPORTED',
        warnings: [`renderer ${options.renderer} 未实现；只支持 builtin（不会自动回退）`],
        exit_code: 1,
      }),
      exitCode: 1,
    };
  }
  let built;
  try {
    if (options.fixture) built = await buildFixtureSpec(options);
    else if (options.evidencePath !== null) built = await buildEvidenceSpec(options);
    else built = await buildConceptualSpec(options);
  } catch (error) {
    const code = error instanceof CliError ? error.code : 'INVALID_INPUT';
    return {
      summary: summaryOf({ status: 'failed', renderer: options.renderer, code, warnings: [String(error.message)], exit_code: 1 }),
      exitCode: 1,
    };
  }
  const spec = built.spec;
  const meta = {
    mode: spec.mode,
    source_state: spec.source_state,
    nodes: spec.nodes.length,
    edges: spec.edges.length,
    truncated: spec.coverage?.truncated === true,
    warnings: warningsForSpec(spec),
  };
  const outputRoot = path.resolve(process.cwd(), options.out);
  const now = options.fixture ? FIXTURE_CLOCK : new Date().toISOString();
  const overlay = emptyOverlay({ diagram_id: spec.diagram_id, base_spec_digest: specDigest(spec), now });
  const archive = createArchive(options.fixture ? { clock: () => FIXTURE_CLOCK } : {});
  const result = await archive.renderLocal(
    {
      spec,
      overlay,
      output_ref: built.outputRef,
      renderer: options.renderer,
      expected_output_revision: null,
      operation_id: built.operationId,
    },
    { granted: true, granted_output_root: outputRoot },
  );
  if (result.status !== 'saved') {
    return {
      summary: summaryOf({
        ...meta,
        status: result.status,
        renderer: options.renderer,
        code: result.code,
        warnings: [...meta.warnings, `renderLocal 返回 ${result.status}/${result.code}`],
        exit_code: 1,
      }),
      exitCode: 1,
    };
  }
  const inspection = await inspectArtifact(result.artifact_ref, outputRoot);
  const warnings = [...meta.warnings, ...inspection.warnings];
  if (offlinePolicy().network !== 'none') warnings.push('offline policy is not none');
  const summary = summaryOf({
    ...meta,
    status: inspection.ok ? 'saved' : 'failed',
    renderer: options.renderer,
    artifact_ref: result.artifact_ref,
    manifest_digest: result.manifest_digest,
    warnings,
    checks: inspection.checks,
    exit_code: inspection.ok ? 0 : 1,
  });
  return { summary, exitCode: summary.exit_code };
}

/** @param {string[]} [argv] */
export async function main(argv = process.argv.slice(2)) {
  const result = await runRender(argv);
  if (result.helpText !== undefined) process.stdout.write(`${result.helpText}\n`);
  else process.stdout.write(`${JSON.stringify(result.summary, null, 2)}\n`);
  process.exitCode = result.exitCode;
  return result.exitCode;
}

function isInvokedDirectly() {
  if (typeof process.argv[1] !== 'string' || process.argv[1].length === 0) return false;
  try {
    return pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isInvokedDirectly()) {
  main().catch((error) => {
    process.stdout.write(`${JSON.stringify({ schema_version: 1, command: 'node tools/render.mjs', status: 'failed', code: 'INTERNAL_FAILURE', warnings: [String(error?.message ?? error)], exit_code: 1 }, null, 2)}\n`);
    process.exitCode = 1;
  });
}
