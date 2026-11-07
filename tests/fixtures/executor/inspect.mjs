/**
 * Fake locked executor: reports its argv, cwd, and environment as one JSON
 * object on stdout, then exits 0. Used by tests/runner.test.mjs to prove that
 * the runner passes an args array (never a shell string), a contained cwd, and
 * only the allowed environment.
 */
import process from 'node:process';

const env = Object.fromEntries(Object.entries(process.env).sort(([left], [right]) => (left < right ? -1 : 1)));
const payload = {
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  env,
};
process.stdout.write(JSON.stringify(payload));
