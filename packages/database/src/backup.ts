import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Backup + verification tooling for Postgres databases (control plane and
 * per-project databases alike — both are just Postgres).
 *
 * - `backupDatabase()` shells to `pg_dump` (custom format) and writes a
 *   manifest: table list + row counts + sha256 of the dump. The manifest
 *   NEVER contains credentials, connection strings, or row contents.
 * - `verifyBackup()` restores into an EMPTY scratch database and compares
 *   table inventory + row counts against the manifest. It refuses when the
 *   target looks like the source database, so verification can never
 *   overwrite production.
 * - Pure pieces (`buildManifest`, `compareInventory`) are unit-tested with
 *   fixtures; live paths are gated on binaries + `LIVE_PG_URL`.
 */

export interface TableStat {
  schema: string;
  name: string;
  rows: number;
}

export interface BackupManifest {
  version: 1;
  id: string;
  database: string;
  host: string;
  createdAt: string;
  appVersion: string;
  tables: TableStat[];
  totalRows: number;
  dumpFile: string;
  dumpSha256: string;
  dumpBytes: number;
}

export interface VerifyReport {
  ok: boolean;
  manifestId: string;
  checkedTables: number;
  mismatches: string[];
  restoredAt: string;
}

export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupError';
  }
}

const SAFE_DB = /^[a-zA-Z_][a-zA-Z0-9_$]*$/;
const SAFE_IDENT = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;

function assertDbName(name: string, what: string): string {
  if (!SAFE_DB.test(name) || name.length > 63) {
    throw new BackupError(`Refusing to operate on suspicious database name (${what})`);
  }
  return name;
}

/** Strip anything credential-shaped from an error/command echo. */
export function redactCommand(text: string): string {
  return text
    .replace(/:[^:/@\s]+@/g, ':•••@')
    .replace(/PGPASSWORD=\S*/g, 'PGPASSWORD=•••')
    .slice(0, 500);
}

async function runBin(
  bin: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync(bin, args, {
      env: opts.env,
      timeout: opts.timeoutMs ?? 300_000,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/ENOENT|not found|not recognized/i.test(msg)) {
      throw new BackupError(
        `${bin} is not installed — backup tooling needs PostgreSQL client binaries`,
      );
    }
    throw new BackupError(redactCommand(msg));
  }
}

export type StatsRunner = (text: string, params: unknown[]) => Promise<Record<string, unknown>[]>;

/** Table inventory + row counts. Pure SQL, parameterized, read-only. */
export async function collectTableStats(run: StatsRunner): Promise<TableStat[]> {
  const tables = (await run(
    `select table_schema as schema, table_name as name
     from information_schema.tables
     where table_schema not in ('pg_catalog', 'information_schema')
       and table_type = 'BASE TABLE'
     order by table_schema, table_name`,
    [],
  )) as { schema: unknown; name: unknown }[];
  const out: TableStat[] = [];
  for (const t of tables.slice(0, 5000)) {
    if (typeof t.schema !== 'string' || typeof t.name !== 'string') continue;
    if (!SAFE_IDENT.test(t.schema) || !SAFE_IDENT.test(t.name)) continue;
    const counted = (await run(
      `select count(*)::bigint as n from "${t.schema}"."${t.name}"`,
      [],
    )) as {
      n: unknown;
    }[];
    const n = counted[0]?.n;
    out.push({ schema: t.schema, name: t.name, rows: typeof n === 'number' ? n : Number(n ?? 0) });
  }
  return out;
}

/** Build + validate a manifest. Throws on tampering-shaped input. */
export function buildManifest(input: {
  database: string;
  host: string;
  appVersion: string;
  tables: TableStat[];
  dumpFile: string;
  dumpSha256: string;
  dumpBytes: number;
}): BackupManifest {
  assertDbName(input.database, 'manifest');
  if (!/^[0-9a-f]{64}$/.test(input.dumpSha256))
    throw new BackupError('Manifest needs a sha256 dump checksum');
  if (!Number.isInteger(input.dumpBytes) || input.dumpBytes <= 0) {
    throw new BackupError('Manifest needs a positive dump size');
  }
  for (const t of input.tables) {
    if (!SAFE_IDENT.test(t.schema) || !SAFE_IDENT.test(t.name)) {
      throw new BackupError('Manifest contains an unsafe identifier');
    }
    if (!Number.isInteger(t.rows) || t.rows < 0)
      throw new BackupError('Manifest contains a bad row count');
  }
  const totalRows = input.tables.reduce((sum, t) => sum + t.rows, 0);
  return {
    version: 1,
    id: randomUUID(),
    database: input.database,
    host: input.host,
    createdAt: new Date().toISOString(),
    appVersion: input.appVersion.slice(0, 50),
    tables: input.tables.map(t => ({ ...t })),
    totalRows,
    dumpFile: input.dumpFile.slice(-200),
    dumpSha256: input.dumpSha256,
    dumpBytes: input.dumpBytes,
  };
}

/** Parse + validate a manifest file. Rejects tampered shapes. */
export async function readManifest(path: string): Promise<BackupManifest> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    throw new BackupError('Manifest is not valid JSON');
  }
  const m = parsed as Record<string, unknown>;
  if (m['version'] !== 1 || typeof m['database'] !== 'string' || !Array.isArray(m['tables'])) {
    throw new BackupError('Manifest has an unknown shape');
  }
  return buildManifest({
    database: m['database'] as string,
    host: typeof m['host'] === 'string' ? (m['host'] as string) : 'unknown',
    appVersion: typeof m['appVersion'] === 'string' ? (m['appVersion'] as string) : 'unknown',
    tables: (m['tables'] as TableStat[]).map(t => ({
      schema: String((t as TableStat).schema ?? ''),
      name: String((t as TableStat).name ?? ''),
      rows: Number((t as TableStat).rows ?? NaN),
    })),
    dumpFile: typeof m['dumpFile'] === 'string' ? (m['dumpFile'] as string) : '',
    dumpSha256: typeof m['dumpSha256'] === 'string' ? (m['dumpSha256'] as string) : '',
    dumpBytes: typeof m['dumpBytes'] === 'number' ? (m['dumpBytes'] as number) : 0,
  });
}

/** Compare a restored inventory against the manifest. Pure + unit-tested. */
export function compareInventory(
  manifest: BackupManifest,
  actual: TableStat[],
): { ok: boolean; mismatches: string[] } {
  const mismatches: string[] = [];
  const have = new Map(actual.map(t => [`${t.schema}.${t.name}`, t.rows]));
  for (const t of manifest.tables) {
    const key = `${t.schema}.${t.name}`;
    if (!have.has(key)) {
      mismatches.push(`missing table ${key}`);
      continue;
    }
    if (have.get(key) !== t.rows) {
      mismatches.push(`row count drift on ${key}: manifest=${t.rows} restored=${have.get(key)}`);
    }
  }
  for (const key of have.keys()) {
    if (!manifest.tables.some(t => `${t.schema}.${t.name}` === key)) {
      mismatches.push(`unexpected table ${key}`);
    }
  }
  return { ok: mismatches.length === 0, mismatches: mismatches.slice(0, 100) };
}

export interface BackupOptions {
  connectionString: string;
  outDir: string;
  appVersion?: string;
  pgDumpBin?: string;
}

function splitUrl(connectionString: string): { host: string; database: string } {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new BackupError('Connection string is not a valid URL');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new BackupError('Connection string must be a postgres:// URL');
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, '') || 'postgres');
  assertDbName(database, 'connection string');
  return { host: url.hostname || 'localhost', database };
}

/**
 * libpq env for a connection string. Auth travels in the environment (the
 * same posture as the Docker provider's `-e POSTGRES_PASSWORD`), never in
 * argv — process listings and error echoes stay credential-free.
 */
function pgEnv(connectionString: string): NodeJS.ProcessEnv {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new BackupError('Connection string is not a valid URL');
  }
  return {
    ...process.env,
    PGHOST: url.hostname || 'localhost',
    PGPORT: url.port || '5432',
    PGUSER: decodeURIComponent(url.username || 'postgres'),
    PGPASSWORD: decodeURIComponent(url.password || ''),
  };
}

/**
 * Dump a database to `<outDir>/cn-backup-<db>-<ts>.dump` + sidecar manifest.
 * Returns paths. Throws BackupError (redacted) on any failure.
 */
export async function backupDatabase(
  opts: BackupOptions,
): Promise<{ dumpPath: string; manifestPath: string; manifest: BackupManifest }> {
  const { host, database } = splitUrl(opts.connectionString);
  await mkdir(opts.outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dumpPath = join(opts.outDir, `cn-backup-${database}-${stamp}.dump`);
  const env = pgEnv(opts.connectionString);
  await runBin(
    opts.pgDumpBin ?? 'pg_dump',
    ['-d', database, '-Fc', '-f', dumpPath, '--no-password'],
    { env },
  );
  const bytes = (await stat(dumpPath)).size;
  if (bytes <= 0) throw new BackupError('pg_dump produced an empty file');
  const hash = createHash('sha256');
  const { createReadStream } = await import('node:fs');
  const stream = createReadStream(dumpPath);
  try {
    for await (const chunk of stream) {
      hash.update(chunk as Uint8Array);
    }
  } catch (err) {
    throw new BackupError(`Cannot read dump file: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200));
  }
  // Row counts come from the live database (same credentials, read-only).
  const { default: postgres } = await import('postgres');
  const sql = postgres(opts.connectionString, { max: 1 });
  let tables: TableStat[] = [];
  try {
    tables = await collectTableStats(
      async (text, params) =>
        (await sql.unsafe(text, params as never[])) as Record<string, unknown>[],
    );
  } finally {
    await sql.end({ timeout: 2 }).catch(() => undefined);
  }
  const manifest = buildManifest({
    database,
    host,
    appVersion: opts.appVersion ?? '0.1.0',
    tables,
    dumpFile: dumpPath.split(/[\\/]/).slice(-1)[0] ?? 'dump',
    dumpSha256: hash.digest('hex'),
    dumpBytes: bytes,
  });
  const manifestPath = `${dumpPath}.manifest.json`;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { dumpPath, manifestPath, manifest };
}

export interface VerifyOptions {
  dumpPath: string;
  manifestPath: string;
  /** Empty scratch database URL. MUST NOT be the source database. */
  scratchUrl: string;
  pgRestoreBin?: string;
  statsRunner?: StatsRunner;
}

/**
 * Verify a backup: checksum the dump, restore into scratch, compare
 * inventory + row counts with the manifest. Refuses to run when the scratch
 * target looks like the source database.
 */
export async function verifyBackup(opts: VerifyOptions): Promise<VerifyReport> {
  const manifest = await readManifest(opts.manifestPath);
  const scratch = splitUrl(opts.scratchUrl);
  if (scratch.database === manifest.database) {
    throw new BackupError(
      'Refusing to restore into the source database — use an empty scratch database',
    );
  }
  const bytes = (await stat(opts.dumpPath)).size;
  if (bytes !== manifest.dumpBytes) {
    return {
      ok: false,
      manifestId: manifest.id,
      checkedTables: 0,
      mismatches: [`dump size drift: manifest=${manifest.dumpBytes} file=${bytes}`],
      restoredAt: new Date().toISOString(),
    };
  }
  const hash = createHash('sha256');
  const { createReadStream } = await import('node:fs');
  try {
    for await (const chunk of createReadStream(opts.dumpPath)) {
      hash.update(chunk as Uint8Array);
    }
  } catch (err) {
    return {
      ok: false,
      manifestId: manifest.id,
      checkedTables: 0,
      mismatches: [`cannot read dump file: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200)],
      restoredAt: new Date().toISOString(),
    };
  }
  if (hash.digest('hex') !== manifest.dumpSha256) {
    return {
      ok: false,
      manifestId: manifest.id,
      checkedTables: 0,
      mismatches: ['dump checksum mismatch — file is corrupt or tampered'],
      restoredAt: new Date().toISOString(),
    };
  }
  const env = pgEnv(opts.scratchUrl);
  await runBin(
    opts.pgRestoreBin ?? 'pg_restore',
    ['--no-password', '--clean', '--if-exists', '-d', scratch.database, opts.dumpPath],
    { env },
  );
  const actual = await collectFromScratch(opts);
  const { ok, mismatches } = compareInventory(manifest, actual);
  return {
    ok,
    manifestId: manifest.id,
    checkedTables: actual.length,
    mismatches,
    restoredAt: new Date().toISOString(),
  };
}

async function collectFromScratch(opts: VerifyOptions): Promise<TableStat[]> {
  if (opts.statsRunner) return collectTableStats(opts.statsRunner);
  const { default: postgres } = await import('postgres');
  const sql = postgres(opts.scratchUrl, { max: 1 });
  try {
    return await collectTableStats(
      async (text, params) =>
        (await sql.unsafe(text, params as never[])) as Record<string, unknown>[],
    );
  } finally {
    await sql.end({ timeout: 2 }).catch(() => undefined);
  }
}
