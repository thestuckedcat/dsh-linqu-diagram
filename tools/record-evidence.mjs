/**
 * Record one actually-executed verification command into evidence/<name>.json.
 *
 * Usage (from the repository root):
 *   node tools/record-evidence.mjs --name final-test-run -- node --test tests/
 *   node tools/record-evidence.mjs --name fixture-render -- node tools/render.mjs --fixture --renderer builtin --out ./scratch-output
 *
 * The script only spawns the given local command (no shell string), captures
 * stdout/stderr, parses `node --test` counters when present, and writes a
 * record in the format documented by evidence/README.md. It never fabricates
 * a pass: the record's `pass` mirrors the real exit code and parsed counters.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

function parseArgs(argv) {
  const args = { name: null, command: [], limitations: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--name') {
      args.name = argv[++index];
    } else if (arg === '--limitation') {
      args.limitations.push(argv[++index]);
    } else if (arg === '--') {
      args.command = argv.slice(index + 1);
      break;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (args.name === null || !/^[a-z0-9-]{1,64}$/.test(args.name)) throw new Error('--name <lower-kebab-case> is required');
  if (args.command.length === 0) throw new Error('-- <command...> is required');
  return args;
}

function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

const { name, command, limitations } = parseArgs(process.argv.slice(2));
const startedAt = new Date().toISOString();
const result = spawnSync(command[0], command.slice(1), {
  cwd: ROOT,
  encoding: 'utf8',
  env: { ...process.env, ARCHIFY_UPDATE_CHECK_DISABLED: '1' },
  windowsHide: true,
  shell: false,
  maxBuffer: 64 * 1024 * 1024,
});
const finishedAt = new Date().toISOString();

const combined = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
function counter(label) {
  const match = combined.match(new RegExp(`^ℹ ${label} (\\d+)$`, 'm'));
  return match === null ? null : Number(match[1]);
}
// Tools other than node --test may print a JSON report with numeric pass/fail
// (e.g. tools/validate.mjs); honour it instead of recording null counters.
let jsonReport = null;
try {
  const parsed = JSON.parse(result.stdout ?? '');
  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) jsonReport = parsed;
} catch {
  // not a JSON report
}
const pass = counter('pass') ?? (jsonReport !== null && Number.isSafeInteger(jsonReport.pass) ? jsonReport.pass : null);
const fail = counter('fail') ?? (jsonReport !== null && Number.isSafeInteger(jsonReport.fail) ? jsonReport.fail : null);
const skipped = counter('skipped') ?? 0;
const spawnError = result.error ? String(result.error.message ?? result.error) : null;
const sourceLock = path.join(ROOT, 'source-lock.json');
const record = {
  schema_version: 1,
  name,
  command: [command[0] === process.execPath ? 'node' : command[0], ...command.slice(1)].join(' '),
  runtime: `node ${process.version} (${process.platform} ${process.arch})`,
  source_lock_digest: fs.existsSync(sourceLock) ? sha256File(sourceLock) : null,
  started_at: startedAt,
  finished_at: finishedAt,
  exit_code: result.status,
  spawn_error: spawnError,
  pass,
  fail,
  skip: skipped,
  status: spawnError === null && result.status === 0 && (fail === null || fail === 0) ? 'passed' : 'failed',
  stdout_tail: (result.stdout ?? '').split('\n').slice(-40).join('\n'),
  stderr_tail: (result.stderr ?? '').split('\n').slice(-40).join('\n'),
  limitations: limitations.length > 0
    ? limitations
    : [
        'Component-level run on synthetic fixtures; no installed Host/browser/OS outlet claim.',
      ],
};
const directory = path.join(ROOT, 'evidence');
fs.mkdirSync(directory, { recursive: true });
const target = path.join(directory, `${name}.json`);
fs.writeFileSync(target, `${JSON.stringify(record, null, 2)}\n`);
process.stderr.write(`${record.status} exit=${record.exit_code} pass=${pass} fail=${fail} skip=${skipped} -> ${path.relative(ROOT, target)}\n`);
process.exit(record.status === 'passed' ? 0 : 1);
