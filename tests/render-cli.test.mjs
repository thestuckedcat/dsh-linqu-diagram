/**
 * T2 CLI integration tests — real evidence/conceptual input through the
 * `node tools/render.mjs` executable (child_process, offline, temp output dirs).
 *
 * Run: node --test tests/render-cli.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_ROOT = path.join(PROJECT_ROOT, 'tests', 'fixtures');
const EVIDENCE = path.join(FIXTURE_ROOT, 'snapshot', 'evidence-subset.json');
const SOURCE_IDENTITY = path.join(FIXTURE_ROOT, 'snapshot', 'source-identity.json');
const CURRENT_IDENTITIES = path.join(FIXTURE_ROOT, 'snapshot', 'current-identities.json');
const STALE_IDENTITIES = path.join(FIXTURE_ROOT, 'snapshot', 'stale-identities.json');
const CONCEPTUAL = path.join(FIXTURE_ROOT, 'conceptual', 'input.json');
const EXPECTED_FILES = ['index.html', 'diagram.svg', 'diagram-spec.json', 'manifest.json', 'evidence.json', 'diagram.drawio', 'annotations.json'];

/** @param {string} directory */
async function tempDir(directory) {
  return mkdtemp(path.join(tmpdir(), `ld-cli-${directory}-`));
}

/**
 * Run the CLI; never throws for non-zero exit (the summary is stdout JSON).
 * @param {string[]} args
 * @param {object} [options]
 * @returns {Promise<{code:number, stdout:string, stderr:string}>}
 */
function runCli(args, options = {}) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ['tools/render.mjs', ...args],
      { cwd: PROJECT_ROOT, encoding: 'utf8', windowsHide: true, timeout: 120_000, ...options },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

/** @param {string} stdout */
function parseSummary(stdout) {
  const trimmed = stdout.trim();
  assert.ok(trimmed.startsWith('{'), 'CLI prints one JSON summary');
  return JSON.parse(trimmed);
}

/** @param {string} text */
function assertNoRemoteRefs(text) {
  assert.equal(/https?:\/\//i.test(text), false, 'CLI text must not contain http(s)://');
}

test('CLI --help documents the real evidence/conceptual flags', async () => {
  const result = await runCli(['--help']);
  assert.equal(result.code, 0);
  for (const flag of ['--evidence', '--source-identity', '--current-identities', '--conceptual', '--out', '--renderer']) {
    assert.ok(result.stdout.includes(flag), `help lists ${flag}`);
  }
});

test('CLI renders a local evidence subset with current identities and is stable across runs', async (t) => {
  const outDir = await tempDir('evidence');
  t.after(async () => rm(outDir, { recursive: true, force: true }));
  const args = ['--evidence', EVIDENCE, '--source-identity', SOURCE_IDENTITY, '--current-identities', CURRENT_IDENTITIES, '--out', outDir];
  const first = await runCli(args);
  assert.equal(first.code, 0, first.stdout + first.stderr);
  assertNoRemoteRefs(first.stdout);
  const summary = parseSummary(first.stdout);
  assert.equal(summary.status, 'saved');
  assert.equal(summary.mode, 'evidence');
  assert.equal(summary.source_state, 'current');
  assert.equal(summary.nodes, 5);
  assert.equal(summary.edges, 4);
  assert.equal(summary.truncated, false);
  assert.match(summary.manifest_digest, /^[0-9a-f]{64}$/);
  assert.equal(summary.exit_code, 0);
  assert.ok(Array.isArray(summary.warnings));
  assert.equal(summary.checks.files, 7);
  assert.equal(summary.checks.remote_refs, 0);
  assert.ok(summary.checks.offline_html);
  assert.ok(summary.checks.manifest_verify);
  const artifactFiles = (await readdir(summary.artifact_ref)).sort();
  assert.deepEqual(artifactFiles, [...EXPECTED_FILES].sort());
  const manifest = JSON.parse(await readFile(path.join(summary.artifact_ref, 'manifest.json'), 'utf8'));
  const packagedSpec = JSON.parse(await readFile(path.join(summary.artifact_ref, 'diagram-spec.json'), 'utf8'));
  assert.equal(manifest.diagram_id, packagedSpec.diagram_id);
  assert.equal(manifest.files.length, 6);
  assert.match(manifest.spec_digest, /^[0-9a-f]{64}$/);
  for (const name of EXPECTED_FILES) {
    assertNoRemoteRefs(await readFile(path.join(summary.artifact_ref, name), 'utf8'));
  }

  const second = await runCli(args);
  assert.equal(second.code, 0, second.stdout + second.stderr);
  const secondSummary = parseSummary(second.stdout);
  assert.equal(secondSummary.manifest_digest, summary.manifest_digest, 'repeated identical input is idempotent');
  assert.equal(secondSummary.artifact_ref, summary.artifact_ref);
});

test('CLI source_state follows --current-identities (stale / unknown)', async (t) => {
  const staleDir = await tempDir('stale');
  const unknownDir = await tempDir('unknown');
  t.after(async () => {
    await rm(staleDir, { recursive: true, force: true });
    await rm(unknownDir, { recursive: true, force: true });
  });
  const stale = await runCli(['--evidence', EVIDENCE, '--source-identity', SOURCE_IDENTITY, '--current-identities', STALE_IDENTITIES, '--out', staleDir]);
  assert.equal(stale.code, 0);
  const staleSummary = parseSummary(stale.stdout);
  assert.equal(staleSummary.source_state, 'stale');
  assert.ok(staleSummary.warnings.some((warning) => warning.includes('stale')));

  const unknown = await runCli(['--evidence', EVIDENCE, '--source-identity', SOURCE_IDENTITY, '--out', unknownDir]);
  assert.equal(unknown.code, 0);
  const unknownSummary = parseSummary(unknown.stdout);
  assert.equal(unknownSummary.source_state, 'unknown');
  assert.ok(unknownSummary.warnings.some((warning) => warning.includes('unknown')));
});

test('CLI renders a local conceptual input file', async (t) => {
  const outDir = await tempDir('conceptual');
  t.after(async () => rm(outDir, { recursive: true, force: true }));
  const result = await runCli(['--conceptual', CONCEPTUAL, '--out', outDir]);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const summary = parseSummary(result.stdout);
  assert.equal(summary.status, 'saved');
  assert.equal(summary.mode, 'conceptual');
  assert.equal(summary.nodes, 3);
  assert.equal(summary.edges, 2);
  assert.equal(summary.checks.files, 7);
});

test('CLI rejects unsupported renderers, remote input paths and missing flags', async (t) => {
  const outDir = await tempDir('reject');
  t.after(async () => rm(outDir, { recursive: true, force: true }));
  const archify = await runCli(['--evidence', EVIDENCE, '--source-identity', SOURCE_IDENTITY, '--renderer', 'archify', '--out', outDir]);
  assert.equal(archify.code, 1);
  const archifySummary = parseSummary(archify.stdout);
  assert.equal(archifySummary.status, 'failed');
  assert.equal(archifySummary.code, 'UNSUPPORTED');

  const remote = await runCli(['--evidence', 'https://evil.example/x.json', '--source-identity', SOURCE_IDENTITY, '--out', outDir]);
  assert.equal(remote.code, 1);
  const remoteSummary = parseSummary(remote.stdout);
  assert.equal(remoteSummary.code, 'INVALID_INPUT');
  assert.ok(remoteSummary.warnings.some((warning) => warning.includes('URL schemes are rejected')));

  const fileScheme = await runCli(['--evidence', 'file:///C:/secret.json', '--source-identity', SOURCE_IDENTITY, '--out', outDir]);
  assert.equal(fileScheme.code, 1);
  assert.equal(parseSummary(fileScheme.stdout).code, 'INVALID_INPUT');

  const unc = await runCli(['--conceptual', '\\\\server\\share\\input.json', '--out', outDir]);
  assert.equal(unc.code, 1);
  assert.equal(parseSummary(unc.stdout).code, 'INVALID_INPUT');

  const missingIdentity = await runCli(['--evidence', EVIDENCE, '--out', outDir]);
  assert.equal(missingIdentity.code, 1);
  assert.equal(parseSummary(missingIdentity.stdout).code, 'INVALID_INPUT');

  const missingMode = await runCli(['--out', outDir]);
  assert.equal(missingMode.code, 1);
  assert.equal(parseSummary(missingMode.stdout).code, 'INVALID_INPUT');
});

test('CLI --fixture remains backward compatible and deterministic', async (t) => {
  const outDir = await tempDir('fixture');
  t.after(async () => rm(outDir, { recursive: true, force: true }));
  const first = await runCli(['--fixture', '--renderer', 'builtin', '--out', outDir]);
  assert.equal(first.code, 0, first.stdout + first.stderr);
  const firstSummary = parseSummary(first.stdout);
  assert.equal(firstSummary.status, 'saved');
  assert.equal(firstSummary.mode, 'evidence');
  assert.equal(firstSummary.source_state, 'current');
  const second = await runCli(['--fixture', '--renderer', 'builtin', '--out', outDir]);
  assert.equal(second.code, 0);
  assert.equal(parseSummary(second.stdout).manifest_digest, firstSummary.manifest_digest);
});
