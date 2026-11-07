/**
 * Fake locked executor: writes a line to stderr and exits with code 3. Used by
 * tests/runner.test.mjs to prove non-zero exits are reported as `failed` with
 * the actual exit code and captured stderr.
 */
import process from 'node:process';

process.stdout.write('fail-fixture:stdout\n');
process.stderr.write('fail-fixture:stderr\n');
process.exitCode = 3;
