/**
 * T2 archive tests: immutable 7-file package, atomic commit, idempotency,
 * cancellation/failure injection (no real disk is filled), crash recovery.
 *
 * Run: node --test tests/archive.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createArchive, artifactFileNames, computeArtifactManifest } from '../src/archive.mjs';
import { emptyOverlay, specDigest, validateManifest, manifestDigest } from '../src/contracts.mjs';
import { toDiagram } from '../src/evidence.mjs';
import { verifyAtlasArtifact, verifyResourceManifest } from '../src/assets.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_ROOT = path.join(PROJECT_ROOT, 'tests', 'fixtures');
const FIXTURE_CLOCK = '2026-11-07T00:00:00.000Z';
const EXPECTED_FILES = ['index.html', 'diagram.svg', 'diagram-spec.json', 'manifest.json', 'evidence.json', 'diagram.drawio', 'annotations.json'];

/** @param {string} filePath */
async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

/** Deterministic stand-in for the T4 drawio exporter (construction-time injection). */
async function stubDrawioExporter() {
  return { xml: '<?xml version="1.0" encoding="UTF-8"?>\n<mxfile host="fixture"><diagram id="fixture" name="fixture">placeholder</diagram></mxfile>', warnings: [] };
}

let cachedSpecs = null;
async function fixtureSpecs() {
  if (cachedSpecs !== null) return cachedSpecs;
  const sourceIdentity = await readJson(path.join(FIXTURE_ROOT, 'snapshot', 'source-identity.json'));
  const evidenceSubset = await readJson(path.join(FIXTURE_ROOT, 'snapshot', 'evidence-subset.json'));
  const currentIdentities = await readJson(path.join(FIXTURE_ROOT, 'snapshot', 'current-identities.json'));
  const evidence = toDiagram(
    { source_identity: sourceIdentity, evidence_subset: evidenceSubset, current_identities: currentIdentities },
    { clock: () => FIXTURE_CLOCK, revision: 1, direction: 'LR' },
  );
  assert.equal(evidence.status, 'ok');
  const conceptualInput = await readJson(path.join(FIXTURE_ROOT, 'conceptual', 'input.json'));
  const conceptual = toDiagram({ conceptual_input: conceptualInput }, { clock: () => FIXTURE_CLOCK, revision: 1, direction: 'LR' });
  assert.equal(conceptual.status, 'ok');
  cachedSpecs = { evidence: evidence.spec, conceptual: conceptual.spec };
  return cachedSpecs;
}

/** @param {any} spec */
function overlayFor(spec) {
  return emptyOverlay({ diagram_id: spec.diagram_id, base_spec_digest: specDigest(spec), now: FIXTURE_CLOCK });
}

async function makeTempDir(label) {
  return mkdtemp(path.join(tmpdir(), `ld-archive-${label}-`));
}

/** @param {any} spec @param {string} outputRoot @param {object} [extra] */
async function requestFor(spec, outputRoot, extra = {}) {
  return {
    spec,
    overlay: overlayFor(spec),
    output_ref: 'fixture',
    renderer: 'builtin',
    expected_output_revision: null,
    operation_id: 'operation-fixture-1',
    ...extra,
  };
}

/** @param {string} root */
function fixtureArchive(root, extra = {}) {
  return createArchive({
    exportDrawio: stubDrawioExporter,
    clock: () => FIXTURE_CLOCK,
    ...extra,
  });
}

/** @param {string} directory */
async function artifactDirs(directory) {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory() && entry.name.startsWith('artifact-')).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}

/** @param {string} filePath */
async function readdirSafe(directory) {
  try {
    return await readdir(directory);
  } catch {
    return [];
  }
}

async function sha256File(filePath) {
  return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

test('saves an immutable 7-file package whose manifest matches the bytes on disk', async (t) => {
  const specs = await fixtureSpecs();
  const root = await makeTempDir('saved');
  t.after(async () => rm(root, { recursive: true, force: true }));
  const archive = fixtureArchive(root);
  const result = await archive.renderLocal(await requestFor(specs.evidence, root), { granted: true, granted_output_root: root });
  assert.equal(result.status, 'saved');
  assert.match(result.manifest_digest, /^[0-9a-f]{64}$/);
  const artifactRef = result.artifact_ref;
  assert.ok(artifactRef.startsWith(path.join(root, 'fixture')));
  assert.deepEqual((await readdir(artifactRef)).sort(), [...EXPECTED_FILES].sort());

  const manifest = await readJson(path.join(artifactRef, 'manifest.json'));
  const validation = validateManifest(manifest);
  assert.equal(validation.ok, true, JSON.stringify(validation.errors));
  assert.equal(manifest.artifact_id, path.basename(artifactRef));
  assert.equal(manifest.diagram_id, specs.evidence.diagram_id);
  assert.equal(manifest.spec_digest, specDigest(specs.evidence));
  assert.equal(manifest.network_mode, 'offline');
  assert.equal(manifest.source_state, specs.evidence.source_state);
  assert.equal(manifest.created_at, FIXTURE_CLOCK);
  assert.equal(manifest.source_digests.length, 1);
  assert.equal(manifest.source_digests[0].source_id, 'local-atlas-synthetic');
  assert.match(manifest.source_digests[0].digest, /^[0-9a-f]{64}$/);
  assert.equal(manifest.files.length, 6, 'manifest.json cannot hash itself; six payload files are listed');
  for (const entry of manifest.files) {
    assert.equal(await sha256File(path.join(artifactRef, entry.relative_path)), entry.sha256);
    assert.equal((await stat(path.join(artifactRef, entry.relative_path))).size, entry.size);
  }
  assert.equal(manifestDigest(manifest), result.manifest_digest);

  // Package-level policy checks.
  const resource = await verifyResourceManifest(manifest, { root: artifactRef });
  assert.deepEqual(resource, { ok: true, errors: [] });
  const html = await verifyAtlasArtifact(path.join(artifactRef, 'index.html'), { allowed_root: root });
  assert.equal(html.ok, true, JSON.stringify(html.errors));
  for (const name of EXPECTED_FILES) {
    const text = await readFile(path.join(artifactRef, name), 'utf8');
    assert.doesNotMatch(text, /https?:\/\//i, `${name} must not contain a remote reference`);
  }
  // The staging area is empty after a successful commit.
  assert.deepEqual(await readdir(path.join(root, 'fixture', '.staging')), []);
});

test('repeated operation returns the same immutable artifact and digest', async (t) => {
  const specs = await fixtureSpecs();
  const root = await makeTempDir('idempotent');
  t.after(async () => rm(root, { recursive: true, force: true }));
  const archive = fixtureArchive(root);
  const caller = { granted: true, granted_output_root: root };
  const first = await archive.renderLocal(await requestFor(specs.evidence, root), caller);
  assert.equal(first.status, 'saved');
  const firstSha = await sha256File(path.join(first.artifact_ref, 'manifest.json'));
  const second = await archive.renderLocal(await requestFor(specs.evidence, root), caller);
  assert.equal(second.status, 'saved');
  assert.equal(second.artifact_ref, first.artifact_ref);
  assert.equal(second.manifest_digest, first.manifest_digest);
  assert.equal(await sha256File(path.join(second.artifact_ref, 'manifest.json')), firstSha);
  assert.equal((await artifactDirs(path.join(root, 'fixture'))).length, 1, 'no second artifact directory');
});

test('same spec with another operation reuses the artifact; different payload under one operation conflicts', async (t) => {
  const specs = await fixtureSpecs();
  const root = await makeTempDir('conflict');
  t.after(async () => rm(root, { recursive: true, force: true }));
  const archive = fixtureArchive(root);
  const caller = { granted: true, granted_output_root: root };
  const first = await archive.renderLocal(await requestFor(specs.evidence, root), caller);
  assert.equal(first.status, 'saved');

  const otherOperation = await archive.renderLocal(await requestFor(specs.evidence, root, { operation_id: 'operation-fixture-2' }), caller);
  assert.equal(otherOperation.status, 'saved');
  assert.equal(otherOperation.artifact_ref, first.artifact_ref);
  assert.equal(otherOperation.manifest_digest, first.manifest_digest);

  const changedSpec = { ...specs.evidence, title: 'changed title' };
  const changed = await archive.renderLocal(await requestFor(changedSpec, root, { operation_id: 'operation-fixture-2' }), caller);
  assert.equal(changed.status, 'conflict');
  assert.equal(changed.code, 'CONFLICT');
  assert.equal((await artifactDirs(path.join(root, 'fixture'))).length, 1, 'conflicting payload must not create a package');

  const changedOverlay = overlayFor(specs.evidence);
  changedOverlay.revision = 3;
  const overlayConflict = await archive.renderLocal(
    await requestFor(specs.evidence, root, { operation_id: 'operation-fixture-1', overlay: changedOverlay }),
    caller,
  );
  assert.equal(overlayConflict.status, 'conflict');
});

test('expected_output_revision mismatch returns STALE_VERSION before writing', async (t) => {
  const specs = await fixtureSpecs();
  const root = await makeTempDir('revision');
  t.after(async () => rm(root, { recursive: true, force: true }));
  const archive = fixtureArchive(root);
  const caller = { granted: true, granted_output_root: root };
  const mismatch = await archive.renderLocal(
    await requestFor(specs.evidence, root, { expected_output_revision: specs.evidence.revision + 1 }),
    caller,
  );
  assert.equal(mismatch.status, 'conflict');
  assert.equal(mismatch.code, 'STALE_VERSION');
  assert.equal((await artifactDirs(path.join(root, 'fixture'))).length, 0);
  const match = await archive.renderLocal(await requestFor(specs.evidence, root, { expected_output_revision: specs.evidence.revision }), caller);
  assert.equal(match.status, 'saved');
});

test('denied caller, unsafe output_ref, unsupported renderer and authorization seam fail closed', async (t) => {
  const specs = await fixtureSpecs();
  const root = await makeTempDir('denied');
  t.after(async () => rm(root, { recursive: true, force: true }));
  const archive = fixtureArchive(root);
  const denied = await archive.renderLocal(await requestFor(specs.evidence, root), {});
  assert.equal(denied.status, 'denied');
  assert.equal(denied.code, 'DENIED');

  const traversal = await archive.renderLocal(await requestFor(specs.evidence, root, { output_ref: '../escape' }), { granted: true, granted_output_root: root });
  assert.equal(traversal.status, 'failed');
  assert.equal(traversal.code, 'INVALID_INPUT');

  const unsupported = await archive.renderLocal(await requestFor(specs.evidence, root, { renderer: 'archify' }), { granted: true, granted_output_root: root });
  assert.equal(unsupported.status, 'failed');
  assert.equal(unsupported.code, 'UNSUPPORTED');

  const spoofedSpec = { ...specs.evidence, renderer_ref: 'archify:other' };
  const spoofed = await archive.renderLocal(await requestFor(spoofedSpec, root, { operation_id: 'operation-spoofed' }), { granted: true, granted_output_root: root });
  assert.equal(spoofed.status, 'failed');
  assert.equal(spoofed.code, 'UNSUPPORTED');

  const unauthorized = fixtureArchive(root, { authorizeOutputRoot: async () => false });
  const seam = await unauthorized.renderLocal(await requestFor(specs.evidence, root), { granted: true, granted_output_root: root });
  assert.equal(seam.status, 'denied');
  assert.equal(seam.code, 'DENIED');
  assert.equal((await artifactDirs(path.join(root, 'fixture'))).length, 0);
});

test('fixture artifacts are byte-reproducible across fresh output roots', async (t) => {
  const specs = await fixtureSpecs();
  const rootA = await makeTempDir('repro-a');
  const rootB = await makeTempDir('repro-b');
  t.after(async () => {
    await rm(rootA, { recursive: true, force: true });
    await rm(rootB, { recursive: true, force: true });
  });
  const savedA = await fixtureArchive(rootA).renderLocal(await requestFor(specs.evidence, rootA), { granted: true, granted_output_root: rootA });
  const savedB = await fixtureArchive(rootB).renderLocal(await requestFor(specs.evidence, rootB), { granted: true, granted_output_root: rootB });
  assert.equal(savedA.status, 'saved');
  assert.equal(savedB.status, 'saved');
  assert.equal(savedA.manifest_digest, savedB.manifest_digest);
  assert.equal(path.basename(savedA.artifact_ref), path.basename(savedB.artifact_ref));
  for (const name of artifactFileNames()) {
    assert.equal(await sha256File(path.join(savedA.artifact_ref, name)), await sha256File(path.join(savedB.artifact_ref, name)), `identical ${name}`);
  }
  // Conceptual fixture, same determinism guarantee.
  const conceptualA = await fixtureArchive(rootA).renderLocal(
    await requestFor(specs.conceptual, rootA, { output_ref: 'conceptual', operation_id: 'operation-conceptual' }),
    { granted: true, granted_output_root: rootA },
  );
  assert.equal(conceptualA.status, 'saved');
});

test('cancellation before commit cleans staging and exposes no package', async (t) => {
  const specs = await fixtureSpecs();
  const root = await makeTempDir('cancel');
  t.after(async () => rm(root, { recursive: true, force: true }));
  const controller = new AbortController();
  let writes = 0;
  const archive = fixtureArchive(root, {
    io: {
      writeFileDurable: async (filePath, data) => {
        writes += 1;
        const handle = await open(filePath, 'w');
        try {
          await handle.writeFile(data);
          await handle.sync();
        } finally {
          await handle.close();
        }
        if (writes === 2) controller.abort();
      },
    },
  });
  const result = await archive.renderLocal(
    await requestFor(specs.evidence, root),
    { granted: true, granted_output_root: root },
    controller.signal,
  );
  assert.equal(result.status, 'cancelled');
  assert.equal(result.code, 'CANCELLED');
  assert.equal((await artifactDirs(path.join(root, 'fixture'))).length, 0, 'no usable package after cancellation');
  assert.deepEqual(await readdir(path.join(root, 'fixture', '.staging')), [], 'staging cleaned');
  assert.deepEqual(await readdirSafe(path.join(root, '.operations')), [], 'no operation record after cancellation');
});

test('injected disk-full (ENOSPC) fails without exposing a half package', async (t) => {
  const specs = await fixtureSpecs();
  const root = await makeTempDir('enospc');
  t.after(async () => rm(root, { recursive: true, force: true }));
  let writes = 0;
  const archive = fixtureArchive(root, {
    io: {
      writeFileDurable: async (filePath, data) => {
        writes += 1;
        if (writes === 3) {
          const error = new Error('no space left on device');
          // @ts-ignore injected kernel-style error code
          error.code = 'ENOSPC';
          throw error;
        }
        const handle = await open(filePath, 'w');
        try {
          await handle.writeFile(data);
          await handle.sync();
        } finally {
          await handle.close();
        }
      },
    },
  });
  const result = await archive.renderLocal(await requestFor(specs.evidence, root), { granted: true, granted_output_root: root });
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'FAILED');
  assert.equal((await artifactDirs(path.join(root, 'fixture'))).length, 0);
  assert.deepEqual(await readdir(path.join(root, 'fixture', '.staging')), [], 'staging cleaned after failure');
  assert.deepEqual(await readdirSafe(path.join(root, '.operations')), [], 'no operation record for failed write');
});

test('injected rename failure leaves no visible package and cleans staging', async (t) => {
  const specs = await fixtureSpecs();
  const root = await makeTempDir('rename');
  t.after(async () => rm(root, { recursive: true, force: true }));
  let renames = 0;
  const archive = fixtureArchive(root, {
    io: {
      rename: async (from, to) => {
        renames += 1;
        if (renames === 1) {
          const error = new Error('simulated rename failure');
          // @ts-ignore injected error code
          error.code = 'EIO';
          throw error;
        }
        await rename(from, to);
      },
    },
  });
  const result = await archive.renderLocal(await requestFor(specs.evidence, root), { granted: true, granted_output_root: root });
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'FAILED');
  assert.equal((await artifactDirs(path.join(root, 'fixture'))).length, 0);
  assert.deepEqual(await readdir(path.join(root, 'fixture', '.staging')), []);
});

test('durable write order: seven staging files fsynced before the atomic rename', async (t) => {
  const specs = await fixtureSpecs();
  const root = await makeTempDir('durable');
  t.after(async () => rm(root, { recursive: true, force: true }));
  /** @type {string[]} */ const writes = [];
  let fsyncDirectories = 0;
  const archive = fixtureArchive(root, {
    io: {
      writeFileDurable: async (filePath, data) => {
        writes.push(filePath);
        const handle = await open(filePath, 'w');
        try {
          await handle.writeFile(data);
          await handle.sync();
        } finally {
          await handle.close();
        }
      },
      fsyncDir: async () => {
        fsyncDirectories += 1;
      },
    },
  });
  const result = await archive.renderLocal(await requestFor(specs.evidence, root), { granted: true, granted_output_root: root });
  assert.equal(result.status, 'saved');
  const stagingWrites = writes.filter((filePath) => filePath.includes(`${path.sep}.staging${path.sep}`));
  assert.equal(stagingWrites.length, 7, 'all seven package files written to staging');
  assert.equal(stagingWrites.at(-1).endsWith('manifest.json'), true, 'manifest is written last');
  assert.ok(fsyncDirectories >= 1, 'staging directory fsynced');
});

test('crash recovery finishes a complete staging package on the next attempt', async (t) => {
  const specs = await fixtureSpecs();
  const root = await makeTempDir('recover');
  t.after(async () => rm(root, { recursive: true, force: true }));
  const caller = { granted: true, granted_output_root: root };
  const first = await fixtureArchive(root).renderLocal(await requestFor(specs.evidence, root), caller);
  assert.equal(first.status, 'saved');
  const artifactId = path.basename(first.artifact_ref);
  const collectionDir = path.join(root, 'fixture');
  const stagingDir = path.join(collectionDir, '.staging', 'operation-fixture-1');
  await mkdir(path.dirname(stagingDir), { recursive: true });
  await rename(first.artifact_ref, stagingDir);
  await rm(path.join(root, '.operations', 'operation-fixture-1.json'));
  assert.equal((await artifactDirs(collectionDir)).length, 0);

  const recovered = await fixtureArchive(root).renderLocal(await requestFor(specs.evidence, root), caller);
  assert.equal(recovered.status, 'saved');
  assert.equal(path.basename(recovered.artifact_ref), artifactId);
  assert.equal(recovered.manifest_digest, first.manifest_digest);
  assert.equal((await artifactDirs(collectionDir)).length, 1);
  assert.deepEqual(await readdir(path.join(collectionDir, '.staging')), [], 'staging consumed by recovery');
  const manifest = await readJson(path.join(recovered.artifact_ref, 'manifest.json'));
  assert.equal(validateManifest(manifest).ok, true);
});

test('an incomplete or corrupt final artifact is never overwritten', async (t) => {
  const specs = await fixtureSpecs();
  const root = await makeTempDir('corrupt');
  t.after(async () => rm(root, { recursive: true, force: true }));
  const caller = { granted: true, granted_output_root: root };
  const first = await fixtureArchive(root).renderLocal(await requestFor(specs.evidence, root), caller);
  assert.equal(first.status, 'saved');
  await rm(path.join(first.artifact_ref, 'manifest.json'));
  const retried = await fixtureArchive(root).renderLocal(await requestFor(specs.evidence, root), caller);
  assert.notEqual(retried.status, 'saved');
  assert.equal(retried.status, 'conflict');
  assert.equal((await artifactDirs(path.join(root, 'fixture'))).length, 1, 'no new directory for a corrupt artifact');
  assert.equal((await readdir(first.artifact_ref)).includes('manifest.json'), false, 'corrupt artifact left untouched for inspection');

  // Without an operation record the same corruption is reported as unknown.
  await rm(path.join(root, '.operations', 'operation-fixture-1.json'));
  const unknown = await fixtureArchive(root).renderLocal(await requestFor(specs.evidence, root), caller);
  assert.equal(unknown.status, 'outcome_unknown');
  assert.equal(unknown.code, 'OUTCOME_UNKNOWN');
});

test('stale partial staging from an earlier crash is discarded and the artifact is rebuilt', async (t) => {
  const specs = await fixtureSpecs();
  const root = await makeTempDir('partial');
  t.after(async () => rm(root, { recursive: true, force: true }));
  const stagingDir = path.join(root, 'fixture', '.staging', 'operation-fixture-1');
  await mkdir(stagingDir, { recursive: true });
  await writeFile(path.join(stagingDir, 'half-written.html'), '<html>');
  const result = await fixtureArchive(root).renderLocal(await requestFor(specs.evidence, root), { granted: true, granted_output_root: root });
  assert.equal(result.status, 'saved');
  assert.deepEqual(await readdir(path.join(root, 'fixture', '.staging')), []);
});

test('package size limit rejects before any staging write', async (t) => {
  const specs = await fixtureSpecs();
  const root = await makeTempDir('sizelimit');
  t.after(async () => rm(root, { recursive: true, force: true }));
  const archive = fixtureArchive(root, { limits: { package_bytes: 1024 } });
  const result = await archive.renderLocal(await requestFor(specs.evidence, root), { granted: true, granted_output_root: root });
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'LIMIT_EXCEEDED');
  assert.equal((await artifactDirs(path.join(root, 'fixture'))).length, 0);
});

test('computeArtifactManifest hashes payload files and rejects self-hash/invalid ids', async () => {
  assert.deepEqual(artifactFileNames(), EXPECTED_FILES);
  assert.notEqual(artifactFileNames(), artifactFileNames(), 'callers get a copy');
  const specs = await fixtureSpecs();
  const spec = specs.evidence;
  const artifactId = `artifact-${'a'.repeat(24)}`;
  const files = [
    { relative_path: 'index.html', content: '<html></html>' },
    { relative_path: 'diagram.svg', content: '<svg/>' },
  ];
  const manifest = computeArtifactManifest({
    artifact_id: artifactId,
    spec,
    overlay: overlayFor(spec),
    files,
    renderer_ref: spec.renderer_ref,
    created_at: FIXTURE_CLOCK,
  });
  assert.equal(validateManifest(manifest).ok, true, JSON.stringify(validateManifest(manifest).errors));
  assert.deepEqual(manifest.files.map((file) => file.relative_path), ['diagram.svg', 'index.html']);
  assert.equal(manifest.files[1].sha256, createHash('sha256').update('<html></html>').digest('hex'));
  assert.equal(manifest.files[1].size, '<html></html>'.length);
  assert.equal(manifest.spec_digest, specDigest(spec));
  assert.throws(() => computeArtifactManifest({ artifact_id: artifactId, spec, files: [{ relative_path: 'manifest.json', content: '{}' }], renderer_ref: spec.renderer_ref, created_at: FIXTURE_CLOCK }), (error) => error.code === 'INVALID_INPUT');
  assert.throws(() => computeArtifactManifest({ artifact_id: 'not-an-artifact-id', spec, files, renderer_ref: spec.renderer_ref, created_at: FIXTURE_CLOCK }), (error) => error.code === 'INVALID_INPUT');
  assert.throws(() => computeArtifactManifest({ artifact_id: artifactId, spec, files, renderer_ref: '', created_at: FIXTURE_CLOCK }), (error) => error.code === 'INVALID_INPUT');
});


