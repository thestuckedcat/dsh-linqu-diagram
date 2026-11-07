/**
 * T2 asset policy tests — resource manifest build/verify, offline HTML gate.
 *
 * Run: node --test tests/assets.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildResourceManifest,
  verifyResourceManifest,
  verifyAtlasArtifact,
  mediaTypeFor,
  offlinePolicy,
} from '../src/assets.mjs';
import { renderHtml } from '../src/render-html.mjs';
import { emptyOverlay, specDigest } from '../src/contracts.mjs';
import { toDiagram } from '../src/evidence.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_ROOT = path.join(PROJECT_ROOT, 'tests', 'fixtures');
const FIXTURE_CLOCK = '2026-11-07T00:00:00.000Z';

/** @param {string} filePath */
async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

/** @param {string} label @returns {Promise<string>} temp dir registered for cleanup by the caller */
async function makeTempDir(label) {
  return mkdtemp(path.join(tmpdir(), `ld-assets-${label}-`));
}

async function fixtureHtml() {
  const sourceIdentity = await readJson(path.join(FIXTURE_ROOT, 'snapshot', 'source-identity.json'));
  const evidenceSubset = await readJson(path.join(FIXTURE_ROOT, 'snapshot', 'evidence-subset.json'));
  const result = toDiagram(
    { source_identity: sourceIdentity, evidence_subset: evidenceSubset },
    { clock: () => FIXTURE_CLOCK, revision: 1, direction: 'LR' },
  );
  assert.equal(result.status, 'ok');
  const overlay = emptyOverlay({ diagram_id: result.spec.diagram_id, base_spec_digest: specDigest(result.spec), now: FIXTURE_CLOCK });
  return renderHtml({ spec: result.spec, overlay }).html;
}

test('buildResourceManifest records sorted sha256/size/media_type deterministically', async (t) => {
  const root = await makeTempDir('build');
  t.after(async () => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'b.txt'), 'bravo');
  await mkdir(path.join(root, 'nested'));
  await writeFile(path.join(root, 'nested', 'a.json'), '{"a":1}');
  await writeFile(path.join(root, 'c.svg'), '<svg/>');

  const result = await buildResourceManifest(['b.txt', 'nested/a.json', 'c.svg'], { root });
  assert.equal(result.ok, true);
  const manifest = result.manifest;
  assert.equal(manifest.schema_version, 1);
  assert.equal(manifest.network_mode, 'offline');
  assert.deepEqual(manifest.files.map((file) => file.relative_path), ['b.txt', 'c.svg', 'nested/a.json']);
  assert.deepEqual(manifest.files.map((file) => file.media_type), ['text/plain', 'image/svg+xml', 'application/json']);
  assert.equal(manifest.files[0].sha256, createHash('sha256').update('bravo').digest('hex'));
  assert.equal(manifest.files[0].size, 5);
  assert.equal(manifest.files[1].size, 6);
  assert.equal(manifest.total_size, 5 + 6 + 7);
  // Same bytes => same manifest regardless of input order.
  const again = await buildResourceManifest(['c.svg', 'nested/a.json', 'b.txt'], { root });
  assert.deepEqual(again.manifest, manifest);
});

test('buildResourceManifest rejects traversal, absolute, backslash, duplicate, missing and directories', async (t) => {
  const root = await makeTempDir('reject');
  t.after(async () => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'a.txt'), 'a');
  await mkdir(path.join(root, 'dir'));

  const traversal = await buildResourceManifest(['../escape.txt'], { root });
  assert.equal(traversal.ok, false);
  assert.match(traversal.errors[0].message, /traversal|escape/);

  const absolute = await buildResourceManifest([path.join(root, 'a.txt')], { root });
  assert.equal(absolute.ok, false);

  const backslash = await buildResourceManifest(['nested\\a.txt'], { root });
  assert.equal(backslash.ok, false);

  const duplicate = await buildResourceManifest(['a.txt', 'a.txt'], { root });
  assert.equal(duplicate.ok, false);

  const missing = await buildResourceManifest(['missing.txt'], { root });
  assert.equal(missing.ok, false);

  const directory = await buildResourceManifest(['dir'], { root });
  assert.equal(directory.ok, false);

  const badMedia = await buildResourceManifest([{ relative_path: 'a.txt', media_type: 'text/javascript' }], { root });
  assert.equal(badMedia.ok, false);

  const noRoot = await buildResourceManifest(['a.txt'], { root: path.join(root, 'nope') });
  assert.equal(noRoot.ok, false);
});

test('buildResourceManifest enforces package size and file count limits', async (t) => {
  const root = await makeTempDir('limits');
  t.after(async () => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'a.txt'), '0123456789');
  await writeFile(path.join(root, 'b.txt'), 'x');

  const tooBig = await buildResourceManifest(['a.txt'], { root, limits: { package_bytes: 4 } });
  assert.equal(tooBig.ok, false);
  assert.match(JSON.stringify(tooBig.errors), /exceeds package limit/);

  const tooMany = await buildResourceManifest(['a.txt', 'b.txt'], { root, limits: { artifact_files: 1 } });
  assert.equal(tooMany.ok, false);
  assert.match(JSON.stringify(tooMany.errors), /file count/);
});

test('verifyResourceManifest re-reads bytes and detects tampering', async (t) => {
  const root = await makeTempDir('verify');
  t.after(async () => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'a.txt'), 'alpha');
  await writeFile(path.join(root, 'b.txt'), 'beta');
  const built = await buildResourceManifest(['a.txt', 'b.txt'], { root });
  assert.equal(built.ok, true);

  const verified = await verifyResourceManifest(built.manifest, { root });
  assert.deepEqual(verified, { ok: true, errors: [] });

  const tampered = { ...built.manifest, files: built.manifest.files.map((file) => ({ ...file })) };
  tampered.files[0].sha256 = '0'.repeat(64);
  const tamperedResult = await verifyResourceManifest(tampered, { root });
  assert.equal(tamperedResult.ok, false);
  assert.ok(tamperedResult.errors.some((error) => error.keyword === 'digest'));

  const wrongSize = await verifyResourceManifest({ ...built.manifest, total_size: 1 }, { root });
  assert.equal(wrongSize.ok, false);

  const wrongNetwork = await verifyResourceManifest({ ...built.manifest, network_mode: 'online' }, { root });
  assert.equal(wrongNetwork.ok, false);

  const duplicate = { ...built.manifest, files: [built.manifest.files[0], built.manifest.files[0]] };
  const duplicateResult = await verifyResourceManifest(duplicate, { root });
  assert.equal(duplicateResult.ok, false);

  await writeFile(path.join(root, 'a.txt'), 'ALPHA');
  const changed = await verifyResourceManifest(built.manifest, { root });
  assert.equal(changed.ok, false, 'changed bytes must fail verification');
  assert.ok(changed.errors.some((error) => error.keyword === 'digest' || error.keyword === 'size'));

  await rm(path.join(root, 'b.txt'));
  const missing = await verifyResourceManifest(built.manifest, { root });
  assert.equal(missing.ok, false);
});

test('verifyAtlasArtifact accepts a generated offline HTML artifact', async (t) => {
  const root = await makeTempDir('atlas-ok');
  t.after(async () => rm(root, { recursive: true, force: true }));
  const htmlPath = path.join(root, 'index.html');
  await writeFile(htmlPath, await fixtureHtml());
  const result = await verifyAtlasArtifact(htmlPath, { allowed_root: root });
  assert.deepEqual(result, { ok: true, errors: [] });
});

test('verifyAtlasArtifact rejects remote resources, dynamic code and missing CSP', async (t) => {
  const root = await makeTempDir('atlas-bad');
  t.after(async () => rm(root, { recursive: true, force: true }));
  const valid = await fixtureHtml();
  const htmlPath = path.join(root, 'index.html');

  const cases = [
    ['remote script', valid.replace('</body>', '<script src="https://evil.example/x.js"></script></body>')],
    ['external link', valid.replace('</head>', '<link rel="stylesheet" href="https://evil.example/x.css"/></head>')],
    ['iframe', valid.replace('</body>', '<iframe src="data:text/html,x"></iframe></body>')],
    ['http in comment', valid.replace('</body>', '<!-- https://evil.example --></body>')],
    ['eval', valid.replace('</body>', '<script>eval("1+1")</script></body>')],
    ['fetch', valid.replace('</body>', '<script>fetch("https://evil.example")</script></body>')],
    ['missing csp', valid.replace(/<meta http-equiv="Content-Security-Policy"[^>]*\/>/, '')],
    ['missing charset', valid.replace(/<meta charset="utf-8"\/>/, '')],
    ['javascript scheme', valid.replace('</body>', '<a href="javascript:alert(1)">x</a></body>')],
    ['file scheme', valid.replace('</body>', '<img src="file:///C:/secret.png"/></body>')],
    ['svg data image', valid.replace('</body>', '<img src="data:image/svg+xml;base64,PHN2Zz4="></body>')],
    ['tampered inline script', valid.replace(INLINE_SCRIPT_PLACEHOLDER, '(() => { /*tampered*/ })();')],
    ['weak csp', valid.replace("default-src 'none'", "default-src 'self'")],
  ];
  for (const [label, html] of cases) {
    await writeFile(htmlPath, html);
    const result = await verifyAtlasArtifact(htmlPath, { allowed_root: root });
    assert.equal(result.ok, false, `must reject: ${label}`);
    assert.ok(result.errors.length > 0, `errors reported for: ${label}`);
  }

  const outside = await makeTempDir('atlas-root');
  t.after(async () => rm(outside, { recursive: true, force: true }));
  await writeFile(htmlPath, valid);
  const outsideResult = await verifyAtlasArtifact(htmlPath, { allowed_root: outside });
  assert.equal(outsideResult.ok, false);
  assert.match(JSON.stringify(outsideResult.errors), /outside the allowed root/);

  const txtPath = path.join(root, 'artifact.txt');
  await writeFile(txtPath, valid);
  const txtResult = await verifyAtlasArtifact(txtPath, { allowed_root: root });
  assert.equal(txtResult.ok, false);

  await writeFile(htmlPath, valid);
  const smallLimit = await verifyAtlasArtifact(htmlPath, { allowed_root: root, limits: { package_bytes: 10 } });
  assert.equal(smallLimit.ok, false);
});

// The fixed script is inlined once; tests replace it by its exact source text.
const INLINE_SCRIPT_PLACEHOLDER = /\(\(\) => \{\n[\s\S]*?\n\}\)\(\);/;

test('offlinePolicy and mediaTypeFor are fixed and deterministic', () => {
  assert.deepEqual(offlinePolicy(), { network: 'none', allowed_origins: [] });
  assert.equal(mediaTypeFor('index.html'), 'text/html');
  assert.equal(mediaTypeFor('diagram.svg'), 'image/svg+xml');
  assert.equal(mediaTypeFor('manifest.json'), 'application/json');
  assert.equal(mediaTypeFor('diagram.drawio'), 'application/xml');
  assert.equal(mediaTypeFor('unknown.bin'), null);
});
