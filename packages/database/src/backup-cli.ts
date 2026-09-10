import { backupDatabase, verifyBackup } from './backup.js';

/**
 * Backup CLI (also wired as npm scripts):
 *   npm run db:backup --workspace=packages/database
 *     [--url $DATABASE_URL] [--out ./backups]
 *   npm run db:verify-backup --workspace=packages/database
 *     --dump <file.dump> --manifest <file.manifest.json> --scratch <url>
 *
 * Connection strings come from env/argv only — never printed. The verify
 * command refuses scratch targets that match the source database.
 */

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  const value = i === -1 ? undefined : process.argv[i + 1];
  return value && !value.startsWith('--') ? value : undefined;
}

async function main(): Promise<void> {
  const [command] = process.argv.slice(2);
  if (command === 'backup') {
    const url = flag('--url') ?? process.env.DATABASE_URL ?? '';
    if (!url) throw new Error('Provide --url or DATABASE_URL');
    const outDir = flag('--out') ?? './backups';
    const { dumpPath, manifest, manifestPath } = await backupDatabase({
      connectionString: url,
      outDir,
      appVersion: process.env.npm_package_version ?? '0.1.0',
    });
    process.stdout.write(
      `backup ok: ${manifest.tables.length} tables, ${manifest.totalRows} rows\n` +
        `dump: ${dumpPath}\n` +
        `manifest: ${manifestPath}\n`,
    );
    return;
  }
  if (command === 'verify') {
    const dumpPath = flag('--dump');
    const manifestPath = flag('--manifest');
    const scratchUrl = flag('--scratch') ?? process.env.SCRATCH_DATABASE_URL ?? '';
    if (!dumpPath || !manifestPath || !scratchUrl) {
      throw new Error('verify needs --dump, --manifest, and --scratch (or SCRATCH_DATABASE_URL)');
    }
    const report = await verifyBackup({ dumpPath, manifestPath, scratchUrl });
    process.stdout.write(
      `verify ${report.ok ? 'ok' : 'FAILED'}: ${report.checkedTables} tables checked\n` +
        report.mismatches.map(m => ` - ${m}\n`).join(''),
    );
    if (!report.ok) process.exitCode = 1;
    return;
  }
  throw new Error('Usage: db:backup backup|verify … (see file header)');
}

main().catch(err => {
  console.error(`backup failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
