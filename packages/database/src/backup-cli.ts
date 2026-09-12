import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backupDatabase, readManifest, restoreDump, verifyBackup } from './backup.js';
import { decryptDumpfile } from './backup-scheduler.js';

/**
 * Backup CLI (also wired as npm scripts):
 *   npm run db:backup --workspace=packages/database
 *     [--url $DATABASE_URL] [--out ./backups]
 *   npm run db:verify-backup --workspace=packages/database
 *     --dump <file.dump> --manifest <file.manifest.json> --scratch <url>
 *   restore (operator-driven, see docs/operations.md):
 *     tsx src/backup-cli.ts restore --dump <file.dump[.enc]> \
 *       --manifest <file.manifest.json> --target <url> [--key-env BACKUP_ENCRYPTION_KEY]
 *
 * Connection strings come from env/argv only — never printed. The verify
 * command refuses scratch targets that match the source database. The
 * restore command requires --confirm-target <dbname> as a second,
 * deliberate confirmation before touching the target.
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
  if (command === 'restore') {
    const dumpPath = flag('--dump');
    const manifestPath = flag('--manifest');
    const targetUrl = flag('--target') ?? process.env.RESTORE_TARGET_URL ?? '';
    const confirm = flag('--confirm-target');
    const keyEnv = flag('--key-env') ?? 'BACKUP_ENCRYPTION_KEY';
    if (!dumpPath || !manifestPath || !targetUrl || !confirm) {
      throw new Error(
        'restore needs --dump, --manifest, --target and --confirm-target <dbname>',
      );
    }
    const manifest = await readManifest(manifestPath);
    if (confirm !== manifest.database) {
      throw new Error(
        `--confirm-target must exactly match the manifest database ("${manifest.database}")`,
      );
    }
    let plainDump = dumpPath;
    let scratch: string | null = null;
    if (dumpPath.endsWith('.enc')) {
      const key = process.env[keyEnv] ?? '';
      if (!key) throw new Error(`Encrypted dump needs ${keyEnv} in the environment`);
      scratch = await mkdtemp(join(tmpdir(), 'cn-restore-'));
      plainDump = join(scratch, 'restore.dump');
      await decryptDumpfile(dumpPath, key, plainDump);
    }
    try {
      const done = await restoreDump({ dumpPath: plainDump, targetUrl });
      process.stdout.write(
        `restore ok: ${manifest.tables.length} tables from manifest ${manifest.id}\n` +
          `target: ${done.target} (${done.host}), ${done.bytes} bytes restored\n`,
      );
    } finally {
      if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
    }
    return;
  }
  throw new Error('Usage: db:backup backup|verify|restore … (see file header)');
}

main().catch(err => {
  console.error(`backup failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
