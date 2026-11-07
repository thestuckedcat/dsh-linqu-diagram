#!/usr/bin/env node
/**
 * 06 local diagrams — offline render CLI (T2 acceptance surface).
 *
 * Usage:
 *   node tools/render.mjs --fixture [--conceptual] [--renderer builtin] [--out DIR]
 *   node tools/render.mjs --evidence <subset.json> --source-identity <identity.json>
 *                         [--current-identities <identity.json|array.json>]
 *                         [--verify-evidence-roots <repo-roots.json>]
 *                         [--scope-ref T] [--title T] [--diagram-id ID] [--revision N]
 *                         [--renderer builtin] [--out DIR]
 *   node tools/render.mjs --conceptual <input.json> [overrides...] [--out DIR]
 *   node tools/render.mjs --import-drawio <file.drawio> [--out DIR]
 *
 * The CLI reads only local files (URL/UNC paths are rejected), pipes the input
 * through src/evidence.mjs toDiagram -> layout -> renderLocal (builtin), writes
 * an immutable artifact package under --out only, verifies it (resource
 * manifest, offline HTML policy, zero remote references, 7 files) and prints a
 * single JSON summary. It never opens a network connection.
 */
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createArchive, artifactFileNames } from '../src/archive.mjs';
import { buildResourceManifest, verifyResourceManifest, verifyAtlasArtifact, offlinePolicy } from '../src/assets.mjs';
import { canonicalJson, sha256Hex } from '../src/canonical.mjs';
import { emptyOverlay, specDigest, validateDiagramSpec } from '../src/contracts.mjs';
import { toDiagram } from '../src/evidence.mjs';
import { importExternalDrawio } from '../src/drawio/import.mjs';
import { LIMITS } from '../src/limits.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_ROOT = path.join(PROJECT_ROOT, 'tests', 'fixtures');
/** Fixed clock keeps fixture artifact bytes reproducible across runs. */
const FIXTURE_CLOCK = '2026-11-07T00:00:00.000Z';
const REMOTE_REF_PATTERN = /https?:\/\//gi;

const USAGE = `usage:
  node tools/render.mjs --fixture [--conceptual] [--renderer builtin] [--out DIR]
  node tools/render.mjs --evidence <path> --source-identity <path> [--current-identities <path>]
                        [--verify-evidence-roots <repo-roots.json>]
                        [--scope-ref <text>] [--title <text>] [--diagram-id <id>]
                        [--revision <n>] [--renderer builtin] [--out DIR]
  node tools/render.mjs --conceptual <path> [overrides...] [--renderer builtin] [--out DIR]
  node tools/render.mjs --import-drawio <path> [--renderer builtin] [--out DIR]
flags:
  --fixture              render the synthetic snapshot fixture (deterministic fixed clock)
  --evidence <path>      local EvidenceSubset JSON file (evidence mode, needs --source-identity)
  --source-identity <p>  local SourceIdentityV1 JSON file
  --current-identities <p> local SourceIdentityV1 or array JSON (source_state current/stale/unknown)
  --verify-evidence-roots <p> local JSON map {repo_id: local root}; content-checks evidence refs
                        (file exists, line range inside file, path stays inside root). Without it the
                        summary says evidence_verification=structural-only: refs are caller-supplied.
  --conceptual <path>    local conceptual input JSON file (title/scope_ref/nodes/edges)
  --import-drawio <path> import an external/historical .drawio as a conceptual annotation layer
                         (always untrusted: geometry/text/endpoints only; unknown shapes -> unsupported)
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
    verifyEvidenceRootsPath: null,
    importDrawioPath: null,
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
    } else if (argument === '--verify-evidence-roots') {
      index += 1;
      options.verifyEvidenceRootsPath = takeValue(index, '--verify-evidence-roots');
    } else if (argument === '--import-drawio') {
      index += 1;
      options.importDrawioPath = takeValue(index, '--import-drawio');
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
  const modeCount = [options.fixture, options.conceptualPath !== null, options.evidencePath !== null, options.importDrawioPath !== null].filter(Boolean).length;
  if (modeCount !== 1) {
    throw new CliError('INVALID_INPUT', 'exactly one of --fixture, --conceptual <path>, --evidence <path>, --import-drawio <path> is required');
  }
  if (options.fixtureConceptual && !options.fixture) {
    throw new CliError('INVALID_INPUT', 'flag-only --conceptual is only meaningful together with --fixture');
  }
  if ((options.sourceIdentityPath !== null || options.currentIdentitiesPath !== null) && options.evidencePath === null) {
    throw new CliError('INVALID_INPUT', '--source-identity/--current-identities are only valid with --evidence');
  }
  if (options.verifyEvidenceRootsPath !== null && options.evidencePath === null) {
    throw new CliError('INVALID_INPUT', '--verify-evidence-roots is only valid with --evidence');
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

/**
 * Build a synchronous local-root verifier for evidence refs (independent review
 * R-02). It checks that each ref's repo-relative path exists under the declared
 * root, stays inside it (realpath-checked), and that the line range fits the
 * file. It deliberately does NOT pretend to verify `content_digest`: the Atlas
 * digest scheme is not part of this repository's contract, so a future 04/Atlas
 * manifest reader must supply the digest check. Without this flag the CLI only
 * reports `structural-only` and HTML/manifest keep that note.
 * @param {string} rootsPath
 * @param {any} sourceIdentity
 */
async function buildEvidenceVerifier(rootsPath, sourceIdentity) {
  const mapping = await readLocalJson(rootsPath, '--verify-evidence-roots');
  if (mapping === null || typeof mapping !== 'object' || Array.isArray(mapping)) {
    throw new CliError('INVALID_INPUT', '--verify-evidence-roots must be a JSON object mapping repo_id to a local root');
  }
  const repoIds = new Set((sourceIdentity?.repos ?? []).map((repo) => repo.repo_id));
  const roots = new Map();
  for (const [repoId, rootValue] of Object.entries(mapping)) {
    if (!repoIds.has(repoId)) throw new CliError('INVALID_INPUT', `--verify-evidence-roots names undeclared repo ${JSON.stringify(repoId)}`);
    if (typeof rootValue !== 'string' || rootValue.length === 0) {
      throw new CliError('INVALID_INPUT', `--verify-evidence-roots.${repoId} must be a local directory path`);
    }
    const resolved = path.resolve(process.cwd(), assertLocalPath(rootValue, `--verify-evidence-roots.${repoId}`));
    let real;
    try {
      real = realpathSync(resolved);
      if (!statSync(real).isDirectory()) throw new Error('not a directory');
    } catch {
      throw new CliError('INVALID_INPUT', `--verify-evidence-roots.${repoId} is not a readable local directory`);
    }
    roots.set(repoId, real);
  }
  const lineCache = new Map();
  const lineCount = (file) => {
    if (!lineCache.has(file)) lineCache.set(file, readFileSync(file, 'utf8').split(/\r?\n/u).length);
    return lineCache.get(file);
  };
  return (ref) => {
    const root = roots.get(ref.repo_id);
    if (root === undefined) return { ok: false, reason: `repo ${ref.repo_id} has no verification root` };
    const candidate = path.resolve(root, ref.path_ref);
    if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
      return { ok: false, reason: `path_ref escapes the verification root: ${ref.path_ref}` };
    }
    let real;
    try {
      real = realpathSync(candidate);
    } catch {
      return { ok: false, reason: `file not found under the verification root: ${ref.path_ref}` };
    }
    if (real !== root && !real.startsWith(`${root}${path.sep}`)) {
      return { ok: false, reason: `path_ref resolves outside the verification root: ${ref.path_ref}` };
    }
    if (!statSync(real).isFile()) return { ok: false, reason: `path_ref is not a regular file: ${ref.path_ref}` };
    if (ref.line_end > lineCount(real)) {
      return { ok: false, reason: `line range ${ref.line_start}-${ref.line_end} exceeds ${ref.path_ref}` };
    }
    return { ok: true };
  };
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
  const policy = { ...specOverrides(options), clock: () => new Date().toISOString() };
  let verification = 'structural-only';
  if (options.verifyEvidenceRootsPath !== null) {
    policy.verify_evidence = await buildEvidenceVerifier(options.verifyEvidenceRootsPath, sourceIdentity);
    verification = 'trusted-local-roots';
  }
  const result = toDiagram(input, policy);
  if (result.status !== 'ok') {
    const detail = Array.isArray(result.errors) && result.errors.length > 0 ? `: ${result.errors[0].message}` : '';
    throw new CliError(result.code ?? 'INVALID_SPEC', `evidence subset failed to produce a valid diagram spec${detail}`);
  }
  const spec = applyScopeRef(result.spec, options);
  const operationId = `render-evidence-${sha256Hex(canonicalJson({
    evidence_subset: evidenceSubset,
    source_identity: sourceIdentity,
    current_identities: input.current_identities ?? null,
    verification,
    overrides: { scope_ref: options.scopeRef, title: options.title, diagram_id: options.diagramId, revision: options.revision },
  })).slice(0, 16)}`;
  return { spec, outputRef: 'evidence', operationId, verification };
}

/** @param {string} filePath @param {string} label */
async function readLocalText(filePath, label) {
  const resolved = path.resolve(process.cwd(), assertLocalPath(filePath, label));
  let stats;
  try {
    stats = await stat(resolved);
  } catch {
    throw new CliError('INVALID_INPUT', `${label} file does not exist: ${filePath}`);
  }
  if (!stats.isFile()) throw new CliError('INVALID_INPUT', `${label} is not a regular file: ${filePath}`);
  if (stats.size > LIMITS.xml_bytes) throw new CliError('LIMIT_EXCEEDED', `${label} exceeds ${LIMITS.xml_bytes} bytes`);
  try {
    return await readFile(resolved, 'utf8');
  } catch {
    throw new CliError('INVALID_INPUT', `${label} is not readable: ${filePath}`);
  }
}

/** @param {object} options */
async function buildImportSpec(options) {
  const text = await readLocalText(options.importDrawioPath, '--import-drawio');
  const imported = importExternalDrawio(text, {});
  if (imported.status === 'unsupported') {
    throw new CliError('UNSUPPORTED', imported.errors?.[0]?.message ?? 'external drawio contains unsupported features; export uncompressed XML first');
  }
  if (imported.status === 'invalid') {
    throw new CliError(imported.code ?? 'INVALID_XML', imported.errors?.[0]?.message ?? 'external drawio is not a restricted mxGraph XML document');
  }
  const operationId = `render-import-${sha256Hex(text).slice(0, 16)}`;
  return {
    spec: imported.base_spec,
    overlay: imported.overlay,
    outputRef: 'import',
    operationId,
    verification: null,
    import_warnings: imported.warnings ?? [],
  };
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
  if (spec.mode === 'evidence' && Array.isArray(spec.coverage?.notes) && spec.coverage.notes.some((note) => String(note).includes('structurally validated only'))) {
    warnings.push('evidence_verification=structural-only：evidence_refs 仅结构校验，exact 是输入自报证据；真实内容核对应由 04/Atlas manifest 或 --verify-evidence-roots 提供。');
  }
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
    evidence_verification: values.evidence_verification ?? null,
    overlay_items: Number.isSafeInteger(values.overlay_items) ? values.overlay_items : 0,
    ...(Array.isArray(values.import_warnings) ? { import_warnings: values.import_warnings } : {}),
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
    else if (options.importDrawioPath !== null) built = await buildImportSpec(options);
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
    evidence_verification: built.verification ?? (spec.mode === 'evidence' ? 'structural-only' : null),
    overlay_items: Array.isArray(built.overlay?.items) ? built.overlay.items.length : 0,
    warnings: [...warningsForSpec(spec), ...(Array.isArray(built.import_warnings) ? built.import_warnings : [])],
    ...(Array.isArray(built.import_warnings) ? { import_warnings: built.import_warnings } : {}),
  };
  const outputRoot = path.resolve(process.cwd(), options.out);
  const now = options.fixture ? FIXTURE_CLOCK : new Date().toISOString();
  const overlay = built.overlay ?? emptyOverlay({ diagram_id: spec.diagram_id, base_spec_digest: specDigest(spec), now });
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
