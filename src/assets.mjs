/**
 * 06 local diagrams — offline asset/resource policy (DIA-05).
 *
 * Frozen interface (docs/interfaces.md §5):
 *   buildResourceManifest(files, {root})        -> {ok, manifest|errors}
 *   verifyResourceManifest(manifest, {root, limits}) -> {ok, errors[]}
 *   verifyAtlasArtifact(htmlPath, {allowed_root})    -> {ok, errors[]}
 *   offlinePolicy()                             -> {network:'none', allowed_origins:[]}
 *
 * Policy: the artifact package is self-contained. A resource manifest records
 * relative path, media type, size and sha256 for every file, and verification
 * re-reads bytes from disk (never trusts a previous listing). Existing Atlas
 * HTML is only accepted when it stays inside the allowed root and has no
 * remote reference, no external script/link/frame, no eval/XHR-style code and
 * a deny-by-default CSP.
 */
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { LIMITS } from './limits.mjs';

/** Media types allowed inside an offline artifact package. */
export const ALLOWED_MEDIA_TYPES = Object.freeze([
  'text/html',
  'image/svg+xml',
  'application/json',
  'application/xml',
  'text/plain',
]);

const EXTENSION_MEDIA_TYPES = Object.freeze({
  '.html': 'text/html',
  '.htm': 'text/html',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.drawio': 'application/xml',
  '.xml': 'application/xml',
  '.txt': 'text/plain',
  '.md': 'text/plain',
});

/** Default media type for a relative path (by extension). */
export function mediaTypeFor(relativePath) {
  const extension = path.extname(String(relativePath)).toLowerCase();
  return EXTENSION_MEDIA_TYPES[extension] ?? null;
}

/** @param {string} message @returns {{path:string,keyword:string,message:string}} */
function issue(pathValue, keyword, message) {
  return { path: pathValue, keyword, message };
}

/**
 * Validate a relative package path and resolve it below `rootRealPath`.
 * Rejects absolute paths, drive letters, UNC, backslashes, `..` segments,
 * empty segments, control characters, ADS streams and over-long paths.
 * @param {unknown} relativePath
 * @param {string} rootRealPath
 * @returns {{ok:true, relative_path:string, resolved:string} | {ok:false, error:object}}
 */
function resolvePackagePath(relativePath, rootRealPath) {
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    return { ok: false, error: issue('$', 'type', 'relative_path must be a non-empty string') };
  }
  if (relativePath.length > LIMITS.relative_path_length) {
    return { ok: false, error: issue(relativePath, 'maxLength', `relative_path exceeds ${LIMITS.relative_path_length} characters`) };
  }
  if (/[\u0000-\u001f\u007f]/.test(relativePath)) {
    return { ok: false, error: issue(relativePath, 'pattern', 'relative_path contains control characters') };
  }
  if (relativePath.includes('\\')) {
    return { ok: false, error: issue(relativePath, 'pattern', 'relative_path must use forward slashes') };
  }
  if (path.isAbsolute(relativePath) || /^[A-Za-z]:/.test(relativePath) || relativePath.startsWith('//')) {
    return { ok: false, error: issue(relativePath, 'pattern', 'relative_path must not be absolute') };
  }
  const segments = relativePath.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      return { ok: false, error: issue(relativePath, 'pattern', 'relative_path contains an empty or traversal segment') };
    }
    if (segment.includes(':')) {
      return { ok: false, error: issue(relativePath, 'pattern', 'relative_path must not contain a drive or stream separator') };
    }
  }
  const resolved = path.resolve(rootRealPath, ...segments);
  const normalizedRoot = rootRealPath.endsWith(path.sep) ? rootRealPath : rootRealPath + path.sep;
  if (resolved !== rootRealPath && !resolved.startsWith(normalizedRoot)) {
    return { ok: false, error: issue(relativePath, 'pattern', 'relative_path escapes the package root') };
  }
  return { ok: true, relative_path: relativePath, resolved };
}

/**
 * Resolve a required existing directory to its real path.
 * @param {unknown} root
 * @returns {{ok:true, root_real_path:string} | {ok:false, error:object}}
 */
function resolveRoot(root) {
  if (typeof root !== 'string' || root.length === 0) {
    return { ok: false, error: issue('$', 'required', 'root is required') };
  }
  try {
    const resolved = path.resolve(root);
    const real = realpathSync(resolved);
    if (!statSync(real).isDirectory()) return { ok: false, error: issue('$', 'type', 'root must be a directory') };
    return { ok: true, root_real_path: real };
  } catch {
    return { ok: false, error: issue('$', 'exists', 'root does not exist or is not readable') };
  }
}

/**
 * @param {unknown} value
 * @param {string} [fallback]
 * @returns {{ok:true, media_type:string} | {ok:false, error:object}}
 */
function resolveMediaType(value, fallback) {
  const mediaType = typeof value === 'string' && value.length > 0 ? value : fallback;
  if (typeof mediaType !== 'string' || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(mediaType) || !ALLOWED_MEDIA_TYPES.includes(mediaType)) {
    return { ok: false, error: issue('$', 'enum', 'media_type is not in the offline allow list') };
  }
  return { ok: true, media_type: mediaType };
}

/** @param {unknown} data */
function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

/** @param {number|undefined} value @param {number} fallback */
function limitValue(value, fallback) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

/**
 * Build a resource manifest for files under `root`. Reads bytes and records
 * sha256/size/media_type in deterministic (relative path sorted) order.
 * @param {(string|{relative_path:string,media_type?:string})[]} files
 * @param {{root:string, limits?:object}} options
 * @returns {{ok:true, manifest:object} | {ok:false, errors:object[]}}
 */
export function buildResourceManifest(files, options = {}) {
  if (!Array.isArray(files)) {
    return { ok: false, errors: [issue('$', 'type', 'files must be an array')] };
  }
  const limits = options.limits ?? {};
  const rootResult = resolveRoot(options.root);
  if (!rootResult.ok) return { ok: false, errors: [rootResult.error] };
  /** @type {object[]} */ const errors = [];
  /** @type {object[]} */ const entries = [];
  const seen = new Set();
  const maxFiles = limitValue(limits.artifact_files, LIMITS.artifact_files);
  const maxBytes = limitValue(limits.package_bytes, LIMITS.package_bytes);
  if (files.length > maxFiles) {
    errors.push(issue('$', 'maxItems', `file count ${files.length} exceeds limit ${maxFiles}`));
  }
  let totalSize = 0;
  for (const file of files) {
    const relativePath = typeof file === 'string' ? file : file?.relative_path;
    const pathResult = resolvePackagePath(relativePath, /** @type {string} */ (rootResult.root_real_path));
    if (!pathResult.ok) {
      errors.push(pathResult.error);
      continue;
    }
    if (seen.has(pathResult.relative_path)) {
      errors.push(issue(pathResult.relative_path, 'uniqueItems', 'duplicate relative_path'));
      continue;
    }
    seen.add(pathResult.relative_path);
    const mediaResult = resolveMediaType(typeof file === 'string' ? undefined : file?.media_type, mediaTypeFor(pathResult.relative_path));
    if (!mediaResult.ok) {
      errors.push({ ...mediaResult.error, path: pathResult.relative_path });
      continue;
    }
    try {
      const realFile = realpathSync(pathResult.resolved);
      const normalizedRoot = rootResult.root_real_path.endsWith(path.sep)
        ? rootResult.root_real_path
        : rootResult.root_real_path + path.sep;
      if (realFile !== rootResult.root_real_path && !realFile.startsWith(normalizedRoot)) {
        errors.push(issue(pathResult.relative_path, 'pattern', 'resolved file escapes the package root'));
        continue;
      }
      const stats = lstatSync(realFile);
      if (!stats.isFile()) {
        errors.push(issue(pathResult.relative_path, 'type', 'not a regular file'));
        continue;
      }
      if (stats.size > maxBytes) {
        errors.push(issue(pathResult.relative_path, 'maximum', `file size ${stats.size} exceeds package limit ${maxBytes}`));
        continue;
      }
      const data = readFileSync(realFile);
      if (data.length !== stats.size) {
        errors.push(issue(pathResult.relative_path, 'size', 'file size changed while reading'));
        continue;
      }
      totalSize += data.length;
      entries.push({
        relative_path: pathResult.relative_path,
        media_type: mediaResult.media_type,
        sha256: sha256Hex(data),
        size: data.length,
      });
    } catch {
      errors.push(issue(pathResult.relative_path, 'exists', 'file does not exist or is not readable'));
    }
  }
  if (entries.length > maxFiles) {
    // entries already bounded by the input count check; kept for clarity.
    errors.push(issue('$', 'maxItems', `file count exceeds limit ${maxFiles}`));
  }
  if (totalSize > maxBytes) {
    errors.push(issue('$', 'maximum', `package size ${totalSize} exceeds limit ${maxBytes}`));
  }
  if (errors.length > 0) return { ok: false, errors };
  entries.sort((left, right) => (left.relative_path < right.relative_path ? -1 : left.relative_path > right.relative_path ? 1 : 0));
  return {
    ok: true,
    manifest: {
      schema_version: 1,
      network_mode: 'offline',
      files: entries,
      total_size: totalSize,
    },
  };
}

/**
 * Re-verify a resource manifest against the bytes currently on disk.
 * @param {any} manifest
 * @param {{root:string, limits?:object}} options
 * @returns {{ok:boolean, errors:object[]}}
 */
export function verifyResourceManifest(manifest, options = {}) {
  /** @type {object[]} */ const errors = [];
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { ok: false, errors: [issue('$', 'type', 'manifest must be an object')] };
  }
  if (manifest.schema_version !== 1) {
    errors.push(issue('$.schema_version', 'const', 'schema_version must be 1'));
  }
  if (manifest.network_mode !== 'offline') {
    errors.push(issue('$.network_mode', 'const', "network_mode must be 'offline'"));
  }
  if (!Array.isArray(manifest.files)) {
    return { ok: false, errors: [...errors, issue('$.files', 'type', 'files must be an array')] };
  }
  const limits = options.limits ?? {};
  const rootResult = resolveRoot(options.root);
  if (!rootResult.ok) return { ok: false, errors: [...errors, rootResult.error] };
  const maxFiles = limitValue(limits.artifact_files, LIMITS.artifact_files);
  const maxBytes = limitValue(limits.package_bytes, LIMITS.package_bytes);
  if (manifest.files.length > maxFiles) {
    errors.push(issue('$.files', 'maxItems', `file count ${manifest.files.length} exceeds limit ${maxFiles}`));
  }
  const seen = new Set();
  let totalSize = 0;
  manifest.files.forEach((entry, index) => {
    const entryPath = `$.files[${index}]`;
    if (entry === null || typeof entry !== 'object') {
      errors.push(issue(entryPath, 'type', 'file entry must be an object'));
      return;
    }
    const relativePath = entry.relative_path;
    const pathResult = resolvePackagePath(relativePath, /** @type {string} */ (rootResult.root_real_path));
    if (!pathResult.ok) {
      errors.push({ ...pathResult.error, path: entryPath });
      return;
    }
    if (seen.has(relativePath)) {
      errors.push(issue(entryPath, 'uniqueItems', 'duplicate relative_path'));
      return;
    }
    seen.add(relativePath);
    const mediaResult = resolveMediaType(entry.media_type, mediaTypeFor(relativePath));
    if (!mediaResult.ok) {
      errors.push({ ...mediaResult.error, path: `${entryPath}.media_type` });
      return;
    }
    if (typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
      errors.push(issue(`${entryPath}.sha256`, 'pattern', 'sha256 must be 64 lowercase hex characters'));
      return;
    }
    if (!Number.isSafeInteger(entry.size) || entry.size < 0) {
      errors.push(issue(`${entryPath}.size`, 'type', 'size must be a non-negative integer'));
      return;
    }
    try {
      const realFile = realpathSync(pathResult.resolved);
      const normalizedRoot = rootResult.root_real_path.endsWith(path.sep)
        ? rootResult.root_real_path
        : rootResult.root_real_path + path.sep;
      if (realFile !== rootResult.root_real_path && !realFile.startsWith(normalizedRoot)) {
        errors.push(issue(entryPath, 'pattern', 'resolved file escapes the package root'));
        return;
      }
      const data = readFileSync(realFile);
      totalSize += data.length;
      if (data.length !== entry.size) {
        errors.push(issue(`${entryPath}.size`, 'size', `manifest size ${entry.size} does not match disk size ${data.length}`));
      }
      if (sha256Hex(data) !== entry.sha256) {
        errors.push(issue(`${entryPath}.sha256`, 'digest', 'sha256 does not match the bytes on disk'));
      }
    } catch {
      errors.push(issue(entryPath, 'exists', 'file does not exist or is not readable'));
    }
  });
  if (totalSize > maxBytes) {
    errors.push(issue('$.total_size', 'maximum', `package size ${totalSize} exceeds limit ${maxBytes}`));
  }
  if (Number.isSafeInteger(manifest.total_size) && manifest.total_size !== totalSize) {
    errors.push(issue('$.total_size', 'size', 'manifest total_size does not match the files on disk'));
  }
  return { ok: errors.length === 0, errors };
}

/** Fixed offline policy advertised by this capability. */
export function offlinePolicy() {
  return { network: 'none', allowed_origins: [] };
}

/**
 * Scan HTML text for offline-policy violations. Deliberately a conservative
 * string scan rather than a full parser: accepted HTML is our own fixed
 * template or a previously validated Atlas artifact, both of which are simple.
 * @param {string} html
 * @returns {object[]} errors
 */
function scanOfflineHtml(html) {
  /** @type {object[]} */ const errors = [];
  const reject = (keyword, message) => errors.push(issue('$', keyword, message));
  if (!/<html[\s>]/i.test(html)) reject('format', 'missing html root element');
  if (!/<meta[^>]*charset\s*=(?:"|')?utf-8/i.test(html)) reject('encoding', 'missing meta charset=utf-8');
  const cspMeta = /<meta[^>]*http-equiv\s*=\s*(?:"|')Content-Security-Policy(?:"|')[^>]*>/i.exec(html);
  if (cspMeta === null) {
    reject('csp', 'missing Content-Security-Policy meta');
  } else {
    const contentMatch = /content\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(cspMeta[0]);
    const csp = contentMatch === null ? '' : (contentMatch[1] ?? contentMatch[2] ?? '');
    if (csp.length === 0) reject('csp', 'CSP meta has no content');
    for (const required of ["default-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'none'", "connect-src 'none'"]) {
      if (!csp.includes(required)) reject('csp', `CSP is missing fixed directive: ${required}`);
    }
    if (/unsafe-inline|unsafe-eval|data:\s*;?\s*script/i.test(csp)) reject('csp', 'CSP allows unsafe inline/eval units');
  }
  // External subresources and frames.
  if (/<script[^>]*\bsrc\s*=/i.test(html)) reject('remote', 'external script src is not allowed');
  if (/<link\b/i.test(html)) reject('remote', 'link elements are not allowed in offline artifacts');
  if (/<(?:iframe|frame|object|embed|applet)\b/i.test(html)) reject('remote', 'embedded frames/objects are not allowed');
  if (/(?:src|href|poster|action|formaction)\s*=\s*(?:"|')?\s*(?:https?:)?\/\//i.test(html)) {
    reject('remote', 'remote URL reference detected');
  }
  if (/url\(\s*(?:"|')?\s*(?:https?:)?\/\//i.test(html)) reject('remote', 'remote CSS url() detected');
  if (/\bjavascript\s*:/i.test(html)) reject('scheme', 'javascript: scheme detected');
  if (/\bfile\s*:/i.test(html)) reject('scheme', 'file: scheme detected');
  if (/\bdata\s*:\s*image\/svg\+xml/i.test(html)) reject('scheme', 'inline SVG data resource detected');
  if (/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\s*\(/i.test(html)) {
    reject('network', 'network API usage detected in HTML');
  }
  if (/\beval\s*\(|new\s+Function\s*\(/i.test(html)) reject('code', 'dynamic code evaluation detected');
  // Inline scripts must be covered by a CSP sha256 source.
  const scriptHashes = [...html.matchAll(/script-src[^;]*?'sha256-([A-Za-z0-9+/=]+)'/gi)].map((match) => match[1]);
  const inlineScripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
  if (inlineScripts.length > 0 && scriptHashes.length === 0) {
    reject('csp', 'inline script is not covered by a CSP sha256 source');
  }
  for (const match of inlineScripts) {
    const digest = createHash('sha256').update(match[1], 'utf8').digest('base64');
    if (!scriptHashes.includes(digest)) reject('csp', 'inline script sha256 is not listed in CSP script-src');
  }
  // No remote literal URL anywhere (CSP text has no URL, so this is absolute).
  if (/https?:\/\//i.test(html)) reject('remote', 'http(s):// literal detected');
  return errors;
}

/**
 * Validate an existing offline HTML artifact (e.g. an Atlas viewer export)
 * without rendering it. Only files inside `allowed_root` are read.
 * @param {string} htmlPath
 * @param {{allowed_root:string, limits?:object}} options
 * @returns {{ok:boolean, errors:object[]}}
 */
export function verifyAtlasArtifact(htmlPath, options = {}) {
  /** @type {object[]} */ const errors = [];
  if (typeof options.allowed_root !== 'string' || options.allowed_root.length === 0) {
    return { ok: false, errors: [issue('$', 'required', 'allowed_root is required')] };
  }
  const rootResult = resolveRoot(options.allowed_root);
  if (!rootResult.ok) return { ok: false, errors: [!rootResult.ok ? rootResult.error : issue('$', 'root', 'invalid root')] };
  if (typeof htmlPath !== 'string' || htmlPath.length === 0) {
    return { ok: false, errors: [issue('$', 'type', 'htmlPath must be a non-empty string')] };
  }
  let realFile;
  try {
    realFile = realpathSync(path.resolve(htmlPath));
  } catch {
    return { ok: false, errors: [issue('$', 'exists', 'artifact HTML does not exist or is not readable')] };
  }
  const rootRealPath = rootResult.root_real_path;
  const normalizedRoot = rootRealPath.endsWith(path.sep) ? rootRealPath : rootRealPath + path.sep;
  if (realFile !== rootRealPath && !realFile.startsWith(normalizedRoot)) {
    return { ok: false, errors: [issue('$', 'pattern', 'artifact HTML is outside the allowed root')] };
  }
  if (path.extname(realFile).toLowerCase() !== '.html' && path.extname(realFile).toLowerCase() !== '.htm') {
    return { ok: false, errors: [issue('$', 'format', 'artifact must be an .html file')] };
  }
  const limits = options.limits ?? {};
  const maxBytes = limitValue(limits.package_bytes, LIMITS.package_bytes);
  let stats;
  try {
    stats = statSync(realFile);
  } catch {
    return { ok: false, errors: [issue('$', 'exists', 'artifact HTML is not readable')] };
  }
  if (!stats.isFile()) return { ok: false, errors: [issue('$', 'type', 'artifact HTML is not a regular file')] };
  if (stats.size > maxBytes) return { ok: false, errors: [issue('$', 'maximum', `artifact HTML exceeds ${maxBytes} bytes`)] };
  const html = readFileSync(realFile, 'utf8');
  if (html.includes('\uFFFD')) errors.push(issue('$', 'encoding', 'artifact HTML is not valid UTF-8'));
  errors.push(...scanOfflineHtml(html));
  return { ok: errors.length === 0, errors };
}
