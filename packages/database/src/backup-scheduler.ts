import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, readdir, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backupDatabase, redactCommand, verifyBackup, BackupError } from './backup.js';

/**
 * Automated backup cycle for the control-plane database. Runs from the
 * worker loop when BACKUP_ENABLED=true (both the Railway worker service and
 * `docker compose --profile worker` execute it — the API never does, so a
 * scaled-out API fleet cannot double-schedule).
 *
 * Each cycle: pg_dump → manifest → optional AES-256-GCM encryption →
 * verification (restore-into-scratch when BACKUP_VERIFY_URL is set, else
 * size+sha256 checksum of the stored artifact) → retention prune.
 * Failures throw redacted BackupErrors (logged + observable, never secrets).
 *
 * Storage note: BACKUP_DIR should be a persistent volume in production
 * (Railway volume mount). Ephemeral disk loses backups on redeploy — the
 * scheduler logs the directory at startup so misconfiguration is visible.
 * Provider-managed Postgres backups (e.g. the Railway plugin's) remain the
 * primary safety net; this scheduler is the portable second layer.
 */

export interface ScheduledBackupOptions {
  connectionString: string;
  outDir: string;
  appVersion?: string;
  /** 32+ char passphrase. Empty = plaintext dumps (dev only, refused in prod). */
  encryptionKey?: string;
  isProduction?: boolean;
  retentionCount: number;
  /** Empty scratch DB URL for restore-verification. Unset = checksum-only. */
  verifyUrl?: string;
  pgDumpBin?: string;
  pgRestoreBin?: string;
}

export interface BackupCycleReport {
  /** Stored artifact (encrypted path when encryption is on). */
  artifactPath: string;
  manifestPath: string;
  manifestId: string;
  tables: number;
  totalRows: number;
  artifactBytes: number;
  encrypted: boolean;
  verified: 'restored' | 'checksum';
  pruned: string[];
  finishedAt: string;
}

const DUMP_RE = /^cn-backup-([A-Za-z_][A-Za-z0-9_$]*)-(\d{4}-\d{2}-\d{2}T[\d-]+Z)\.dump(\.enc)?$/;

function keyBytes(passphrase: string): Buffer {
  if (passphrase.length < 16) {
    throw new BackupError('Backup encryption key must be at least 16 characters');
  }
  return createHash('sha256').update(passphrase, 'utf8').digest();
}

/** AES-256-GCM encrypt: file layout [12B IV][16B TAG][ciphertext]. */
export async function encryptDumpfile(dumpPath: string, passphrase: string): Promise<string> {
  const key = keyBytes(passphrase);
  const iv = randomBytes(12);
  const encPath = `${dumpPath}.enc`;
  const tmpPath = `${dumpPath}.enc.tmp`;
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  // GCM tags are NOT auto-appended by cipher streams: encrypt to a temp
  // file, then assemble IV+TAG+ciphertext so decrypt can setAuthTag upfront.
  await pipeline(createReadStream(dumpPath), cipher, createWriteStream(tmpPath, { mode: 0o600 }));
  const tag = cipher.getAuthTag();
  const out = createWriteStream(encPath, { mode: 0o600 });
  out.write(iv);
  out.write(tag);
  await pipeline(createReadStream(tmpPath), out);
  await unlink(tmpPath).catch(() => undefined);
  return encPath;
}

/** Decrypt a file produced by {@link encryptDumpfile}. Wrong key → throws. */
export async function decryptDumpfile(encPath: string, passphrase: string, outPath: string): Promise<void> {
  const key = keyBytes(passphrase);
  const { open } = await import('node:fs/promises');
  const fh = await open(encPath, 'r');
  try {
    const header = Buffer.alloc(28);
    const { bytesRead } = await fh.read(header, 0, 28, 0);
    if (bytesRead !== 28) throw new BackupError('Encrypted backup is truncated (no IV+tag)');
    const decipher = createDecipheriv('aes-256-gcm', key, header.subarray(0, 12));
    decipher.setAuthTag(header.subarray(12, 28));
    // Stream ciphertext from offset 28 without loading the dump into memory.
    const src = createReadStream(encPath, { start: 28 });
    await pipeline(src, decipher, createWriteStream(outPath, { mode: 0o600 }));
  } finally {
    await fh.close().catch(() => undefined);
  }
}

async function sha256File(path: string): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    bytes += (chunk as Uint8Array).length;
    hash.update(chunk as Uint8Array);
  }
  return { sha256: hash.digest('hex'), bytes };
}

/**
 * Keep the newest `keepN` backup groups for `database`, delete older ones
 * (dump + .enc + manifest sidecars). Only touches strict-pattern backup
 * files — anything else in the directory is left alone. Returns pruned
 * basenames for logging.
 */
export async function pruneBackups(outDir: string, database: string, keepN: number): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(outDir);
  } catch {
    return [];
  }
  const groups = new Map<string, string[]>();
  for (const name of names) {
    const base = name.endsWith('.manifest.json') ? name.slice(0, -'.manifest.json'.length) : name;
    const m = DUMP_RE.exec(base);
    if (!m || m[1] !== database) continue;
    const group = `${m[1]}|${m[2]}`;
    const list = groups.get(group) ?? [];
    list.push(name);
    groups.set(group, list);
  }
  const ordered = [...groups.keys()].sort();
  const pruned: string[] = [];
  for (const group of ordered.slice(0, Math.max(0, ordered.length - Math.max(1, keepN)))) {
    for (const name of groups.get(group) ?? []) {
      try {
        await unlink(join(outDir, name));
        pruned.push(name);
      } catch {
        // Best-effort: a failed delete is retried next cycle.
      }
    }
  }
  return pruned;
}

export async function runBackupCycle(opts: ScheduledBackupOptions): Promise<BackupCycleReport> {
  const keep = Math.max(1, Math.min(100, Math.trunc(opts.retentionCount) || 7));
  const encrypt = (opts.encryptionKey ?? '').length > 0;
  if (!encrypt && opts.isProduction) {
    throw new BackupError(
      'Refusing scheduled backup without BACKUP_ENCRYPTION_KEY in production (unencrypted dumps at rest)',
    );
  }
  const { dumpPath, manifestPath, manifest } = await backupDatabase({
    connectionString: opts.connectionString,
    outDir: opts.outDir,
    appVersion: opts.appVersion ?? '0.1.0',
    pgDumpBin: opts.pgDumpBin,
  });
  let artifactPath = dumpPath;
  if (encrypt) {
    artifactPath = await encryptDumpfile(dumpPath, opts.encryptionKey as string);
    await unlink(dumpPath).catch(() => undefined);
  }
  const artifact = await sha256File(artifactPath);
  let verified: 'restored' | 'checksum' = 'checksum';
  if (opts.verifyUrl) {
    // Restore-verify the exact stored artifact: decrypt to a temp dir
    // (never into the backup dir, never near production) and run the
    // standard manifest comparison. Refuses scratch==source by construction.
    const scratch = await mkdtemp(join(tmpdir(), 'cn-verify-'));
    try {
      const verifyDump = join(scratch, 'verify.dump');
      if (encrypt) await decryptDumpfile(artifactPath, opts.encryptionKey as string, verifyDump);
      else await (await import('node:fs/promises')).copyFile(artifactPath, verifyDump);
      const report = await verifyBackup({
        dumpPath: verifyDump,
        manifestPath,
        scratchUrl: opts.verifyUrl,
        pgRestoreBin: opts.pgRestoreBin,
      });
      if (!report.ok) {
        throw new BackupError(`Backup verification failed: ${report.mismatches[0] ?? 'unknown'}`);
      }
      verified = 'restored';
    } finally {
      await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  const pruned = await pruneBackups(opts.outDir, manifest.database, keep);
  return {
    artifactPath,
    manifestPath,
    manifestId: manifest.id,
    tables: manifest.tables.length,
    totalRows: manifest.totalRows,
    artifactBytes: artifact.bytes,
    encrypted: encrypt,
    verified,
    pruned,
    finishedAt: new Date().toISOString(),
  };
}

export function redactBackupError(err: unknown): string {
  return redactCommand(err instanceof Error ? err.message : String(err));
}
