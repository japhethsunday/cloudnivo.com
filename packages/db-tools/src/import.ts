import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BackupError,
  collectTableStats,
  executeRestoreTransaction,
  queryProjectDb,
  redactCommand,
  type ProjectConnectionInfo,
} from '@cloudnivo/database';
import { DbToolsError } from './errors.js';
import { planRestore } from './restore.js';

/**
 * PostgreSQL import: logical dump from an external Postgres URL straight
 * into the caller's project database (Supabase, RDS, self-hosted — anything
 * pg_dump can read). Credentials travel via libpq env only, errors are
 * redacted, and the restore runs in ONE transaction (all-or-nothing) behind
 * the standard restore denylist. Bounded: 50 MB dump cap by default —
 * larger estates use pg_restore via CLI.
 */

export interface PostgresImportOptions {
  sourceUrl: string;
  target: ProjectConnectionInfo;
  maxBytes?: number;
  pgDumpBin?: string;
  timeoutMs?: number;
}

export interface PostgresImportReport {
  sourceHost: string;
  sourceDatabase: string;
  bytes: number;
  tables: number;
  totalRows: number;
  executedStatements: number;
}

const SAFE_DB = /^[a-zA-Z_][a-zA-Z0-9_$]*$/;

function parseSourceUrl(sourceUrl: string): {
  host: string;
  database: string;
  env: NodeJS.ProcessEnv;
} {
  const bad = (message: string): DbToolsError => new DbToolsError('VALIDATION_ERROR', message, 400);
  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    throw bad('Source must be a valid postgres:// URL');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw bad('Source must be a postgres:// URL');
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, '') || 'postgres');
  if (!SAFE_DB.test(database) || database.length > 63) {
    throw bad('Source database name looks unsafe');
  }
  if (!url.hostname) throw bad('Source URL needs a host');
  return {
    host: url.hostname,
    database,
    env: {
      ...process.env,
      PGHOST: url.hostname,
      PGPORT: url.port || '5432',
      PGUSER: decodeURIComponent(url.username || 'postgres'),
      PGPASSWORD: decodeURIComponent(url.password || ''),
    },
  };
}

export async function importFromPostgres(
  opts: PostgresImportOptions,
): Promise<PostgresImportReport> {
  const maxBytes = opts.maxBytes ?? 50_000_000;
  const { host, database, env } = parseSourceUrl(opts.sourceUrl);
  const scratch = await mkdtemp(join(tmpdir(), 'cn-import-'));
  const dumpPath = join(scratch, 'source.sql');
  try {
    await new Promise<void>((resolve, reject) => {
      const out = createWriteStream(dumpPath);
      let bytes = 0;
      let done = false;
      const finish = (err?: Error): void => {
        if (done) return;
        done = true;
        if (err) reject(err);
        else resolve();
      };
      out.on('error', err => finish(err instanceof Error ? err : new Error(String(err))));
      out.on('finish', () => finish());
      const child = spawn(opts.pgDumpBin ?? 'pg_dump', ['-d', database, '--no-owner', '--no-privileges'], {
        env,
        timeout: opts.timeoutMs ?? 600_000,
        windowsHide: true,
      });
      child.on('error', (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        if (/ENOENT|not found|not recognized/i.test(msg)) {
          finish(new BackupError('pg_dump is not installed — imports need PostgreSQL client binaries'));
          return;
        }
        finish(new BackupError(redactCommand(msg)));
      });
      child.stdout?.on('data', (chunk: unknown) => {
        bytes += (chunk as Uint8Array).length;
        if (bytes > maxBytes) {
          try {
            child.kill();
          } catch {
            // Already exiting.
          }
          finish(
            new BackupError(`Source dump exceeds the ${(maxBytes / 1_000_000).toFixed(0)} MB import cap`),
          );
          return;
        }
        if (!out.write(chunk)) child.stdout?.pause();
      });
      out.on('drain', () => child.stdout?.resume());
      child.stdout?.on('end', () => out.end());
      child.on('close', code => {
        if (code !== 0 && !done) {
          finish(new BackupError('pg_dump exited nonzero — check source credentials and reachability'));
        }
      });
    });
    const { size } = await stat(dumpPath);
    if (size <= 0) throw new BackupError('Source dump is empty');
    const text = await readFile(dumpPath, 'utf8');
    const { statements } = planRestore(text, {
      maxBytes: maxBytes + 1_000_000,
      maxStatements: 5000,
    });
    const { executed } = await executeRestoreTransaction(opts.target, statements, opts.timeoutMs ?? 600_000);
    const stats = await collectTableStats(async (t, p) =>
      queryProjectDb({ ...opts.target, database: opts.target.database }, t, p),
    );
    return {
      sourceHost: host,
      sourceDatabase: database,
      bytes: size,
      tables: stats.length,
      totalRows: stats.reduce((a, s) => a + s.rows, 0),
      executedStatements: executed,
    };
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}
