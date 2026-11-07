/**
 * Fake locked executor: writes 1.5 MiB to stdout (more than the 1 MiB
 * executor output cap) and exits 0. Used by tests/runner.test.mjs to prove the
 * cap truncates captured output, terminates the tree, and fails with
 * LIMIT_EXCEEDED instead of reporting a normal success.
 */
import process from 'node:process';

const chunk = 'x'.repeat(64 * 1024);
for (let index = 0; index < 24; index += 1) process.stdout.write(chunk);
