#!/usr/bin/env node
import { run } from './cli.js';
import { describeError } from './commands.js';

/**
 * Exit codes an agent can branch on without parsing prose:
 *   0 success · 2 denied (auth/scope/tenant) · 3 approval required
 *   4 rate limited · 1 everything else.
 */
function exitCodeFor(err: unknown): number {
  const status = (err as { status?: number } | null)?.status;
  if (status === 401 || status === 403) return 2;
  if (status === 428) return 3;
  if (status === 429) return 4;
  return 1;
}

try {
  const output = await run(process.argv.slice(2));
  if (output) process.stdout.write(`${output}\n`);
} catch (err) {
  process.stderr.write(`${describeError(err)}\n`);
  process.exit(exitCodeFor(err));
}
