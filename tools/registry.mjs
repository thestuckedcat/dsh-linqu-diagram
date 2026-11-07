#!/usr/bin/env node
/**
 * tools/registry.mjs —local trusted registration CLI for 06 local diagrams.
 *
 * Only this local CLI (run by the local user) may register new contexts,
 * output roots and documents. Tools, the 08 entry point and normal UI RPC cannot
 * register roots (see docs/interfaces.md §8 and software-design §9).
 *
 * Registry state is written under a local data root:
 *   <data-root>/registry.json         strict DiagramAccessRegistryV1 view
 *   <data-root>/registry.local.json   trusted local path bindings
 * The default data root is `$DSH_HOME/local-diagrams`; pass `--data-root` to
 * isolate tests or use another local directory. The CLI never contacts the
 * network and never writes outside the registry data root.
 *
 * Usage:
 *   node tools/registry.mjs [--data-root <dir>] register-context \
 *       --context-ref <id> --scope-ref <scope> [--scope-generation 0]
 *   node tools/registry.mjs [--data-root <dir>] register-output-root \
 *       --output-ref <id> --scope-ref <scope> [--scope-generation 0] --path <dir>
 *   node tools/registry.mjs [--data-root <dir>] register-document \
 *       --document-ref <id> --document-id <id> --scope-ref <scope> \
 *       [--scope-generation 0] --path <artifact-dir> [--mode edit|read]
 *   node tools/registry.mjs [--data-root <dir>] revoke --kind <context|document|output_root> --ref <id>
 *   node tools/registry.mjs [--data-root <dir>] list
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  loadRegistryFromDirectory,
  saveRegistryToDirectory,
  resolveRegistryDataRoot,
} from '../src/editor/access.mjs';

const USAGE = `usage:
  node tools/registry.mjs [--data-root <dir>] register-context --context-ref <id> --scope-ref <scope> [--scope-generation <n>]
  node tools/registry.mjs [--data-root <dir>] register-output-root --output-ref <id> --scope-ref <scope> [--scope-generation <n>] --path <dir>
  node tools/registry.mjs [--data-root <dir>] register-document --document-ref <id> --document-id <id> --scope-ref <scope> [--scope-generation <n>] --path <artifact-dir> [--mode edit|read]
  node tools/registry.mjs [--data-root <dir>] revoke --kind <context|document|output_root> --ref <id>
  node tools/registry.mjs [--data-root <dir>] list`;

class UsageError extends Error {}

/**
 * @param {string[]} argv
 * @returns {{command:string, options:Record<string,string>}}
 */
function parseArgs(argv) {
  const options = {};
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) {
      positionals.push(argument);
      continue;
    }
    const body = argument.slice(2);
    const equals = body.indexOf('=');
    let name;
    let value;
    if (equals >= 0) {
      name = body.slice(0, equals);
      value = body.slice(equals + 1);
    } else {
      name = body;
      value = argv[index + 1];
      index += 1;
      if (value === undefined || value.startsWith('--')) throw new UsageError(`missing value for --${name}`);
    }
    if (!/^[a-z][a-z0-9-]*$/u.test(name)) throw new UsageError(`invalid option --${name}`);
    options[name.replace(/-/gu, '_')] = value;
  }
  if (positionals.length === 0) throw new UsageError('missing command');
  if (positionals.length > 1) throw new UsageError(`unexpected argument: ${positionals[1]}`);
  return { command: positionals[0], options };
}

/** @param {Record<string,string>} options @param {string[]} allowed @returns {void} */
function assertAllowed(options, allowed) {
  for (const key of Object.keys(options)) {
    if (!allowed.includes(key)) throw new UsageError(`unknown option --${key.replace(/_/gu, '-')}`);
  }
}

/**
 * @param {Record<string,string>} options
 * @param {string} name
 * @param {{required?:boolean}} [behaviour]
 * @returns {string | undefined}
 */
function optionValue(options, name, behaviour = {}) {
  const value = options[name];
  if (value === undefined) {
    if (behaviour.required === true) throw new UsageError(`missing required option --${name}`);
    return undefined;
  }
  return value;
}

/**
 * @param {Record<string,string>} options
 * @returns {number}
 */
function scopeGenerationOption(options) {
  const raw = optionValue(options, 'scope_generation');
  if (raw === undefined) return 0;
  if (!/^\d+$/u.test(raw)) throw new UsageError('--scope-generation must be a non-negative integer');
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new UsageError('--scope-generation is out of range');
  return value;
}

/** @param {unknown} value @returns {void} */
function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}



/** @param {string[]} argv @returns {number} exit code */
export function main(argv) {
  /** @type {{command:string, options:Record<string,string>}} */
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${/** @type {Error} */ (error).message}\n\n${USAGE}\n`);
    return 2;
  }
  const { command, options } = parsed;
  const dataRootFlag = options.data_root;
  try {
    assertAllowed(options, ['data_root', ...allowedFlags(command)]);
  } catch (error) {
    process.stderr.write(`${/** @type {Error} */ (error).message}\n\n${USAGE}\n`);
    return 2;
  }
  try {
    if (command === 'register-context') {
      const entry = {
        context_ref: optionValue(options, 'context_ref', { required: true }),
        scope_ref: optionValue(options, 'scope_ref', { required: true }),
        scope_generation: scopeGenerationOption(options),
      };
      return commitMutation(dataRootFlag, (registry) => registry.registerContext(entry), 'context');
    }
    if (command === 'register-output-root') {
      const entry = {
        output_ref: optionValue(options, 'output_ref', { required: true }),
        scope_ref: optionValue(options, 'scope_ref', { required: true }),
        scope_generation: scopeGenerationOption(options),
        path: path.resolve(optionValue(options, 'path', { required: true })),
      };
      return commitMutation(dataRootFlag, (registry) => registry.registerOutputRoot(entry), 'output_root');
    }
    if (command === 'register-document') {
      const entry = {
        document_ref: optionValue(options, 'document_ref', { required: true }),
        document_id: optionValue(options, 'document_id', { required: true }),
        scope_ref: optionValue(options, 'scope_ref', { required: true }),
        scope_generation: scopeGenerationOption(options),
        path: path.resolve(optionValue(options, 'path', { required: true })),
        mode: optionValue(options, 'mode') ?? 'edit',
      };
      return commitMutation(dataRootFlag, (registry) => registry.registerDocument(entry), 'document');
    }
    if (command === 'revoke') {
      const input = {
        kind: optionValue(options, 'kind', { required: true }),
        ref: optionValue(options, 'ref', { required: true }),
      };
      return commitMutation(dataRootFlag, (registry) => registry.revoke(input), null);
    }
    if (command === 'list') {
      const dataRoot = resolveRegistryDataRoot(dataRootFlag);
      const loaded = loadRegistryFromDirectory(dataRoot);
      const contract = loaded.registry.exportToJson();
      const bindings = loaded.registry.listLocalBindings();
      printJson({
        ok: true,
        revision: contract.revision,
        contexts: contract.contexts,
        documents: contract.documents,
        output_roots: contract.output_roots,
        local_bindings: bindings,
      });
      return 0;
    }
    process.stderr.write(`unknown command: ${command}\n\n${USAGE}\n`);
    return 2;
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n\n${USAGE}\n`);
      return 2;
    }
    const coded = /** @type {any} */ (error);
    printJson({
      ok: false,
      code: typeof coded?.code === 'string' ? coded.code : 'FAILED',
      message: error instanceof Error ? error.message : 'registry operation failed',
    });
    return 1;
  }
}

/**
 * @param {string} command
 * @returns {string[]}
 */
function allowedFlags(command) {
  switch (command) {
    case 'register-context':
      return ['context_ref', 'scope_ref', 'scope_generation'];
    case 'register-output-root':
      return ['output_ref', 'scope_ref', 'scope_generation', 'path'];
    case 'register-document':
      return ['document_ref', 'document_id', 'scope_ref', 'scope_generation', 'path', 'mode'];
    case 'revoke':
      return ['kind', 'ref'];
    case 'list':
      return [];
    default:
      return [];
  }
}

/**
 * @param {string | undefined} dataRootFlag
 * @param {(registry:any) => any} mutate
 * @param {string | null} entryKey
 * @returns {number}
 */
function commitMutation(dataRootFlag, mutate, entryKey) {
  const dataRoot = resolveRegistryDataRoot(dataRootFlag);
  const loaded = loadRegistryFromDirectory(dataRoot);
  const result = mutate(loaded.registry);
  if (!result || result.ok !== true) {
    printJson({ ok: false, code: result?.code ?? 'FAILED', errors: result?.errors ?? [] });
    return 1;
  }
  saveRegistryToDirectory(dataRoot, loaded.registry);
  const contract = loaded.registry.exportToJson();
  printJson({
    ok: true,
    revision: contract.revision,
    entry: entryKey === null ? result : result.entry,
    ...(entryKey === null ? { result } : {}),
  });
  return 0;
}

// Only execute when invoked as a script (unit tests may import main()).
const invokedDirectly =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  process.exitCode = main(process.argv.slice(2));
}
