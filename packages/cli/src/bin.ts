#!/usr/bin/env node
import { run } from './cli.js';

try {
  const output = await run(process.argv.slice(2));
  if (output) process.stdout.write(`${output}\n`);
} catch (err) {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
