/**
 * Grandchild fixture: appends one line to argv[2] every 40 ms until killed.
 * A surviving grandchild keeps growing the file, which is exactly what
 * tests/runner.test.mjs checks for after a timeout/cancel tree kill.
 */
import { appendFileSync } from 'node:fs';
import process from 'node:process';

const targetPath = process.argv[2];
if (typeof targetPath !== 'string' || targetPath.length === 0) process.exit(2);

setInterval(() => {
  try {
    appendFileSync(targetPath, 'tick\n');
  } catch {
    process.exit(0);
  }
}, 40);
