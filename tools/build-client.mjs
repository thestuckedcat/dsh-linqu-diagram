#!/usr/bin/env node
/**
 * tools/build-client.mjs - deterministic bundler for the rc.5 browser half.
 *
 * The 06 client bundle is a LAZY CJS module in the verified rc.5 format:
 *
 *   window.__ModuleLoader__.load({id:'dsh-local-diagrams', factory:(require)=>{...}})
 *
 * There is no TS/TSX build chain in this round, so this tool inlines the pure
 * ESM modules the panel needs (`ui/*.mjs` plus the selected `src/` modules) into
 * one self-contained `plugin/client.js`:
 *
 *  - relative imports are resolved to repo-relative module ids and lowered to a
 *    private synchronous `__require`;
 *  - bare specifiers must be in the rc.5 platform seed table (`react`,
 *    `react/jsx-runtime`, ...) and stay external: the module factory calls the
 *    platform `require` handed in by `window.__ModuleLoader__`;
 *  - `import`/`export` syntax is lowered to CJS (no default/re-export forms are
 *    used or accepted);
 *  - the two `await import('../contracts.mjs')` seams in the editor model /
 *    drawio modules are lowered to synchronous `__require` (the module graph is
 *    acyclic and fully inlined, so materialization order is irrelevant);
 *  - `node:crypto` is mapped to the inlined browser SHA-256 shim
 *    (`ui/hash.mjs`), and a minimal `Buffer.byteLength` is provided in the
 *    bundle factory scope because `src/canonical.mjs` uses it.
 *
 * Determinism: modules are emitted sorted by id; the header carries a digest of
 * the module sources and the tool version, so `--check` fails when the checked-in
 * `plugin/client.js` is stale. No timestamps are embedded.
 *
 * Run:
 *   node tools/build-client.mjs           # write plugin/client.js
 *   node tools/build-client.mjs --check   # exit 1 if plugin/client.js is stale
 *
 * Exit codes: 0 written/current, 1 stale (--check), 2 build error.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT_FILE = path.join(ROOT, 'plugin', 'client.js');
export const ENTRY = 'ui/client-entry.mjs';
export const BUNDLE_ID = 'dsh-local-diagrams';
export const TOOL_VERSION = 1;

/** rc.5 platform seed modules the bundle may require at runtime. */
export const PLATFORM_MODULES = Object.freeze([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  'zod',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
]);

/** Host modules that are lowered to an inlined browser-safe module. */
export const MODULE_SUBSTITUTES = Object.freeze({
  'node:crypto': 'ui/hash.mjs',
});

const PLATFORM_SET = new Set(PLATFORM_MODULES);

/** @param {string} relativePath @returns {string} normalized repo-relative id */
function repoId(relativePath) {
  return relativePath.split(path.sep).join('/');
}

/** @param {string} id @returns {string} */
function moduleDir(id) {
  const index = id.lastIndexOf('/');
  return index === -1 ? '' : id.slice(0, index);
}

/** @param {string} fromId @param {string} specifier @returns {string} */
function resolveRelative(fromId, specifier) {
  const joined = path.posix.normalize(path.posix.join(moduleDir(fromId), specifier));
  if (joined.startsWith('../')) throw new Error(`build-client: module "${fromId}" imports outside the project: ${specifier}`);
  return joined;
}

/** @param {string} file @returns {string} */
function readSource(file) {
  return fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n/gu, '\n');
}

/* -------------------------------------------------------------------------- */
/* ESM lowering                                                                */
/* -------------------------------------------------------------------------- */

const IMPORT_STATEMENT = /^import\s+(?:([\s\S]*?)\s+from\s+)?(['"])([^'"]+)\2\s*;$/u;
const EXPORT_FUNCTION = /^export\s+(async\s+)?function\s+([A-Za-z_$][\w$]*)/u;
const EXPORT_VARIABLE = /^export\s+(const|let|var)\s+([A-Za-z_$][\w$]*)/u;
const EXPORT_CLASS = /^export\s+class\s+([A-Za-z_$][\w$]*)/u;
const DYNAMIC_IMPORT = /await\s+import\(\s*(['"])([^'"]+)\1\s*\)/gu;

/**
 * Lower one import statement (possibly spanning lines) to a `__require` call.
 * @param {string} id
 * @param {string} statement
 * @param {(specifier:string) => string} resolve
 * @returns {string}
 */
function lowerImport(id, statement, resolve) {
  const match = IMPORT_STATEMENT.exec(statement);
  if (match === null) throw new Error(`build-client: "${id}": could not parse import statement`);
  const clause = match[1];
  const target = resolve(match[3]);
  const quote = JSON.stringify(target);
  if (clause === undefined) return `__require(${quote});`;
  const trimmed = clause.trim();
  if (trimmed.startsWith('*')) {
    const namespace = /^\*\s+as\s+([A-Za-z_$][\w$]*)$/u.exec(trimmed);
    if (namespace === null) throw new Error(`build-client: "${id}" has an unsupported namespace import`);
    return `const ${namespace[1]} = __require(${quote});`;
  }
  if (trimmed.startsWith('{')) {
    if (!trimmed.endsWith('}')) throw new Error(`build-client: "${id}" has an unclosed named import`);
    const inner = trimmed.slice(1, -1).trim();
    if (inner === '') return `__require(${quote});`;
    const names = inner.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0);
    const bindings = names.map((entry) => {
      const asMatch = /^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/u.exec(entry);
      if (asMatch !== null) return `${asMatch[1]}: ${asMatch[2]}`;
      if (!/^[A-Za-z_$][\w$]*$/u.test(entry)) throw new Error(`build-client: "${id}" has an unsupported import binding "${entry}"`);
      return entry;
    });
    return `const { ${bindings.join(', ')} } = __require(${quote});`;
  }
  if (!/^[A-Za-z_$][\w$]*$/u.test(trimmed)) throw new Error(`build-client: "${id}" has an unsupported import clause`);
  return `const ${trimmed} = __require(${quote}).default;`;
}

/**
 * Lower one ESM module to a CJS-style body executed inside a wrapper function.
 * @param {string} id repo-relative module id
 * @param {string} source
 * @returns {{code:string, exports:string[], imports:Array<{specifier:string, resolved:string, external:boolean}>}}
 */
export function lowerModule(id, source) {
  /** @type {Array<{specifier:string, resolved:string, external:boolean}>} */
  const imports = [];
  /** @param {string} specifier @returns {string} */
  const resolve = (specifier) => {
    if (Object.hasOwn(MODULE_SUBSTITUTES, specifier)) {
      const resolved = MODULE_SUBSTITUTES[specifier];
      imports.push({ specifier, resolved, external: false });
      return resolved;
    }
    if (specifier.startsWith('node:')) {
      throw new Error(`build-client: "${id}" imports unsupported host module ${specifier}`);
    }
    if (specifier.startsWith('.')) {
      const resolved = resolveRelative(id, specifier);
      imports.push({ specifier, resolved, external: false });
      return resolved;
    }
    if (!PLATFORM_SET.has(specifier)) {
      throw new Error(`build-client: "${id}" imports "${specifier}" which is not in the rc.5 platform seed table`);
    }
    imports.push({ specifier, resolved: specifier, external: true });
    return specifier;
  };

  let text = source;
  if (text.startsWith('#!')) text = text.slice(text.indexOf('\n') + 1);

  // Line-based import lowering: only statements starting at the beginning of a
  // line are imports (a comment that merely contains the word "import" must not
  // be mistaken for a statement).
  const sourceLines = text.split('\n');
  /** @type {string[]} */
  const withoutImports = [];
  for (let index = 0; index < sourceLines.length; index += 1) {
    const line = sourceLines[index];
    if (!/^\s*import\s/u.test(line)) {
      withoutImports.push(line);
      continue;
    }
    if (!/^import\s/u.test(line)) throw new Error(`build-client: "${id}" line ${index + 1}: indented import statements are not supported`);
    let statement = line;
    while (!/;\s*$/u.test(statement)) {
      index += 1;
      if (index >= sourceLines.length) throw new Error(`build-client: "${id}": unterminated import statement`);
      statement += `\n${sourceLines[index]}`;
    }
    withoutImports.push(lowerImport(id, statement.trim(), resolve));
  }
  text = withoutImports.join('\n');

  // Dynamic imports of in-graph modules (contracts seams) become synchronous.
  text = text.replace(DYNAMIC_IMPORT, (_match, _quote, specifier) => {
    if (!specifier.startsWith('.')) throw new Error(`build-client: "${id}" dynamically imports "${specifier}" (only relative graph modules are allowed)`);
    const target = resolveRelative(id, specifier);
    imports.push({ specifier, resolved: target, external: false });
    return `__require(${JSON.stringify(target)})`;
  });

  /** @type {string[]} */
  const exported = [];
  const lines = text.split('\n');
  const output = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*import\b/u.test(line)) throw new Error(`build-client: "${id}" line ${index + 1}: unlowered import statement`);
    if (/^export\s+\{/u.test(line) || /^export\s+default\b/u.test(line) || /^export\s+\*/u.test(line)) {
      throw new Error(`build-client: "${id}" line ${index + 1}: re-export/default export forms are not supported by the bundle`);
    }
    if (/^export\s/u.test(line)) {
      const fn = EXPORT_FUNCTION.exec(line);
      const variable = EXPORT_VARIABLE.exec(line);
      const klass = EXPORT_CLASS.exec(line);
      if (fn !== null) {
        exported.push(fn[2]);
        output.push(line.replace(/^export\s+/u, ''));
      } else if (variable !== null) {
        exported.push(variable[2]);
        output.push(line.replace(/^export\s+/u, ''));
      } else if (klass !== null) {
        exported.push(klass[1]);
        output.push(line.replace(/^export\s+/u, ''));
      } else {
        throw new Error(`build-client: "${id}" line ${index + 1}: unsupported export declaration`);
      }
      continue;
    }
    output.push(line);
  }

  const body = output.join('\n').replace(/\s+$/u, '');
  const tail = exported.map((name) => `exports.${name} = ${name};`).join('\n');
  return {
    code: tail === '' ? body : `${body}\n\n${tail}`,
    exports: exported,
    imports,
  };
}

/* -------------------------------------------------------------------------- */
/* graph + bundle                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Resolve and lower the whole module graph from {@link ENTRY}.
 * @returns {{modules:Array<{id:string, code:string, exports:string[], imports:any[]}>, externals:string[], sourcesDigest:string}}
 */
export function buildModuleGraph() {
  /** @type {Map<string, {id:string, code:string, exports:string[], imports:any[]}>} */
  const modules = new Map();
  /** @type {Set<string>} */
  const externals = new Set();
  /** @type {string[]} */
  const queue = [ENTRY];
  /** @type {Map<string, string>} */
  const sources = new Map();
  while (queue.length > 0) {
    const id = /** @type {string} */ (queue.shift());
    if (modules.has(id)) continue;
    const source = readSource(id);
    sources.set(id, source);
    const lowered = lowerModule(id, source);
    modules.set(id, { id, ...lowered });
    for (const entry of lowered.imports) {
      if (entry.external) externals.add(entry.specifier);
      else if (!modules.has(entry.resolved)) queue.push(entry.resolved);
    }
  }
  const ids = [...modules.keys()].sort();
  /** @type {Array<{id:string, code:string, exports:string[], imports:any[]}>} */
  const ordered = ids.map((id) => modules.get(id));
  const digest = createHash('sha256')
    .update(`tool:${TOOL_VERSION}\n`)
    .update(`entry:${ENTRY}\n`)
    .update(ids.map((id) => `${id}\u0000${sources.get(id)}`).join('\u0001'))
    .digest('hex');
  return { modules: ordered, externals: [...externals].sort(), sourcesDigest: digest };
}

/** @returns {string} */
function utf8ByteLengthCode() {
  return [
    '\t\tfunction __utf8ByteLength(text) {',
    '\t\t\tlet bytes = 0;',
    '\t\t\tfor (let index = 0; index < text.length; index += 1) {',
    '\t\t\t\tconst code = text.charCodeAt(index);',
    '\t\t\t\tif (code < 0x80) bytes += 1;',
    '\t\t\t\telse if (code < 0x800) bytes += 2;',
    '\t\t\t\telse if (code >= 0xd800 && code <= 0xdbff) {',
    '\t\t\t\t\tbytes += 4;',
    '\t\t\t\t\tindex += 1;',
    '\t\t\t\t} else bytes += 3;',
    '\t\t\t}',
    '\t\t\treturn bytes;',
    '\t\t}',
  ].join('\n');
}

/**
 * Render the deterministic bundle text.
 * @param {{modules:Array<{id:string, code:string}>, externals:string[], sourcesDigest:string}} graph
 * @returns {string}
 */
export function renderBundle(graph) {
  const header = [
    '/**',
    ' * dsh-local-diagrams client bundle - GENERATED FILE, DO NOT EDIT.',
    ' *',
    ' * Source: ui/client-entry.mjs and the modules it imports (ui/*.mjs and the',
    ' * selected pure src/ modules). Rebuild with `node tools/build-client.mjs`;',
    ' * `node tools/build-client.mjs --check` fails when this file is stale.',
    ' *',
    ` * bundle id: ${BUNDLE_ID}`,
    ` * tool version: ${TOOL_VERSION}`,
    ` * sources sha256: ${graph.sourcesDigest}`,
    ` * externals: ${graph.externals.length === 0 ? '(none)' : graph.externals.join(', ')}`,
    ' */',
    'window.__ModuleLoader__.load({',
    `\tid: ${JSON.stringify(BUNDLE_ID)},`,
    '\tfactory: (require) => {',
    '\t\tvar module = { exports: {} };',
    '\t\tvar exports = module.exports;',
    '\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });',
    '\t\t// Minimal browser-safe Buffer surface used by src/canonical.mjs.',
    '\t\tvar Buffer = { byteLength: __utf8ByteLength };',
  ];
  header.push(utf8ByteLengthCode());
  header.push('\t\tvar __definitions = Object.create(null);');
  header.push('\t\tvar __cache = Object.create(null);');
  const moduleBlocks = [];
  for (const entry of graph.modules) {
    moduleBlocks.push(`\t\t__definitions[${JSON.stringify(entry.id)}] = function (module, exports, __require) {`);
    moduleBlocks.push(entry.code);
    moduleBlocks.push('\t\t};');
  }
  const footer = [
    '\t\tfunction __require(id) {',
    '\t\t\tif (Object.prototype.hasOwnProperty.call(__definitions, id)) {',
    '\t\t\t\tif (Object.prototype.hasOwnProperty.call(__cache, id)) return __cache[id];',
    '\t\t\t\tvar target = { exports: {} };',
    '\t\t\t\t__definitions[id](target, target.exports, __require);',
    '\t\t\t\t__cache[id] = target.exports;',
    '\t\t\t\treturn target.exports;',
    '\t\t\t}',
    '\t\t\treturn require(id);',
    '\t\t}',
    `\t\tmodule.exports = __require(${JSON.stringify(ENTRY)});`,
    '\t\treturn module.exports;',
    '\t}',
    '});',
    '',
  ];
  return [...header, ...moduleBlocks, ...footer].join('\n');
}

/**
 * Build (or check) plugin/client.js.
 * @param {{check?:boolean, outFile?:string}} [options]
 * @returns {{ok:boolean, status:'written'|'current'|'stale', bytes:number, sha256:string, modules:number, externals:string[], sources_digest:string, file:string}}
 */
export function buildClient(options = {}) {
  const graph = buildModuleGraph();
  const text = renderBundle(graph);
  const target = options.outFile ?? OUT_FILE;
  const sha256 = createHash('sha256').update(text).digest('hex');
  const summary = {
    ok: true,
    status: /** @type {any} */ ('current'),
    bytes: Buffer.byteLength(text, 'utf8'),
    sha256,
    modules: graph.modules.length,
    externals: graph.externals,
    sources_digest: graph.sourcesDigest,
    file: repoId(path.relative(ROOT, target)),
  };
  if (options.check === true) {
    let existing = null;
    try {
      existing = fs.readFileSync(target, 'utf8');
    } catch {
      existing = null;
    }
    const current = existing !== null && existing === text;
    summary.status = current ? 'current' : 'stale';
    summary.ok = current;
    return summary;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text, 'utf8');
  summary.status = 'written';
  return summary;
}

/* -------------------------------------------------------------------------- */
/* CLI                                                                         */
/* -------------------------------------------------------------------------- */

async function main(argv) {
  const check = argv.includes('--check');
  try {
    const summary = buildClient({ check });
    process.stdout.write(`${JSON.stringify({ tool: 'build-client', mode: check ? 'check' : 'write', ...summary }, null, 2)}\n`);
    if (check && summary.status === 'stale') return 1;
    return 0;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      tool: 'build-client',
      mode: check ? 'check' : 'write',
      ok: false,
      status: 'error',
      message: error instanceof Error ? error.message : 'build failed',
    }, null, 2)}\n`);
    return 2;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
