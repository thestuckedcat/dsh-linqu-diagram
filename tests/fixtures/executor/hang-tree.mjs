/**
 * Fake locked executor: spawns a grandchild (`heartbeat.mjs`) that keeps
 * appending to a file, prints both pids as JSON, then stays alive forever.
 * Used by tests/runner.test.mjs to prove timeout/cancel terminate the *owned
 * process tree*: after the runner returns, the heartbeat file stops growing.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const heartbeatPath = process.argv[2];
if (typeof heartbeatPath !== 'string' || heartbeatPath.length === 0) {
  process.stderr.write('hang-tree-fixture: missing heartbeat path argument\n');
  process.exit(2);
}

const grandchild = spawn(process.execPath, [path.join(here, 'heartbeat.mjs'), heartbeatPath], {
  shell: false,
  windowsHide: true,
  stdio: 'ignore',
});

process.stdout.write(
  `${JSON.stringify({ parent_pid: process.pid, grandchild_pid: grandchild.pid ?? null, heartbeat: heartbeatPath })}\n`,
);

// Stay alive until the runner kills the tree.
setInterval(() => {
  /* parent heartbeat: intentionally does nothing */
}, 1000);
