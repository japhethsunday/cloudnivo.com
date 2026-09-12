import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runControlMigrations } from './service.js';

/**
 * Release-time migrator (compiled to dist, zero devDependencies).
 * `railway run` service containers prune devDeps, so `drizzle-kit` is
 * unavailable there — this runs the same journal through drizzle-orm
 * (a production dependency). Usage: `node packages/database/dist/migrate-cli.js`
 * with DATABASE_URL set; never logs secrets.
 */

function migrationsFolder(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, '..', 'drizzle'),
    path.join(process.cwd(), 'packages', 'database', 'drizzle'),
  ];
  for (const folder of candidates) {
    if (existsSync(path.join(folder, 'meta', '_journal.json'))) return folder;
  }
  throw new Error('drizzle migrations folder not found (expected packages/database/drizzle)');
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? '';
  if (!url) throw new Error('DATABASE_URL is required for migration');
  const folder = migrationsFolder();
  process.stdout.write(`migrating from ${folder}\n`);
  await runControlMigrations(url, folder);
  process.stdout.write('migrations complete\n');
}

main().catch(err => {
  console.error(`migrate failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
