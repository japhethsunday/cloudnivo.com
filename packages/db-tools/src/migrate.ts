import { BackupError, queryProjectDb } from '@cloudnivo/database';

/**
 * Migration source assessment (Supabase / RDS / self-hosted Postgres).
 * Read-only probes against the source URL: version, extensions, table
 * inventory + row counts, and RLS usage. The report flags anything
 * CloudNivo handles differently BEFORE any data moves. Credentials travel
 * in memory only and never appear in the report, logs, or errors.
 */

export interface MigrationAssessment {
  sourceHost: string;
  sourceDatabase: string;
  sourceVersion: string;
  tables: { schema: string; name: string; rows: number }[];
  totalRows: number;
  extensions: string[];
  usesRls: boolean;
  warnings: string[];
}

const SAFE_DB = /^[a-zA-Z_][a-zA-Z0-9_$]*$/;

export function parseMigrationSource(sourceUrl: string): {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
} {
  const bad = (message: string): Error => {
    const err = new Error(message) as Error & { code: string; status: number };
    err.code = 'VALIDATION_ERROR';
    err.status = 400;
    return err;
  };
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
  if (!SAFE_DB.test(database) || database.length > 63) throw bad('Source database name looks unsafe');
  if (!url.hostname) throw bad('Source URL needs a host');
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 5432,
    database,
    user: decodeURIComponent(url.username || 'postgres'),
    password: decodeURIComponent(url.password || ''),
  };
}

export async function assessMigrationSource(sourceUrl: string): Promise<MigrationAssessment> {
  const src = parseMigrationSource(sourceUrl);
  const conn = { ...src };
  const run = async (text: string): Promise<Record<string, unknown>[]> =>
    queryProjectDb(conn, text, [], 15_000);
  let version = 'unknown';
  try {
    const v = await run(`select version() as v`);
    version = String(v[0]?.['v'] ?? 'unknown').slice(0, 120);
  } catch {
    throw new BackupError(
      `Cannot reach source database at ${src.host} — check host, credentials, and network access`,
    );
  }
  const tables: MigrationAssessment['tables'] = [];
  try {
    const rows = await run(
      `select table_schema as s, table_name as t from information_schema.tables
       where table_schema not in ('pg_catalog','information_schema')
         and table_type = 'BASE TABLE' order by 1, 2`,
    );
    for (const r of rows.slice(0, 2000)) {
      const schema = String(r['s'] ?? '');
      const name = String(r['t'] ?? '');
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema) || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) continue;
      let count = 0;
      try {
        const c = await run(`select count(*)::bigint as n from "${schema}"."${name}"`);
        count = Number(c[0]?.['n'] ?? 0);
      } catch {
        count = -1;
      }
      tables.push({ schema, name, rows: count });
    }
  } catch {
    // Inventory is best-effort; version already proves reachability.
  }
  let extensions: string[] = [];
  try {
    const rows = await run(`select extname as e from pg_extension order by 1`);
    extensions = rows.map(r => String(r['e'] ?? '')).filter(Boolean);
  } catch {
    extensions = [];
  }
  let usesRls = false;
  try {
    const rows = await run(
      `select count(*)::bigint as n from pg_tables where schemaname not in ('pg_catalog','information_schema') and rowsecurity`,
    );
    usesRls = Number(rows[0]?.['n'] ?? 0) > 0;
  } catch {
    usesRls = false;
  }
  const warnings: string[] = [];
  const unsupported = extensions.filter(e => !['plpgsql', 'pgcrypto', 'uuid-ossp', 'citext', 'pg_trgm', 'unaccent', 'btree_gin', 'btree_gist', 'pg_stat_statements'].includes(e));
  if (unsupported.length > 0) {
    warnings.push(`Source uses extensions not on the CloudNivo allowlist: ${unsupported.slice(0, 10).join(', ')}. Install equivalents or drop them first.`);
  }
  if (usesRls) {
    warnings.push('Source uses row-level security: policies import as table definitions; re-apply RLS rules in CloudNivo after import.');
  }
  if (/supabase/i.test(src.host)) {
    warnings.push('Supabase source detected: auth.users password hashes cannot be reused (bcrypt) — plan a password-reset campaign; migrate auth.users rows as profiles and re-verify emails.');
  }
  const totalRows = tables.reduce((a, t) => a + Math.max(0, t.rows), 0);
  if (totalRows > 10_000_000) {
    warnings.push(`Large estate (~${totalRows} rows): use chunked pg_restore via CLI instead of the API import.`);
  }
  return {
    sourceHost: src.host,
    sourceDatabase: src.database,
    sourceVersion: version,
    tables: tables.slice(0, 500),
    totalRows,
    extensions,
    usesRls,
    warnings,
  };
}
