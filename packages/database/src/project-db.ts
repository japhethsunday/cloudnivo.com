import postgres from 'postgres';

/**
 * Live connections to CUSTOMER project databases.
 *
 * This module is the only place that opens connections to provisioned project
 * databases (the control plane uses `service.ts`). Every function takes
 * explicit connection info resolved server-side — callers must membership-check
 * first. Nothing here logs credentials.
 */

export interface ProjectConnectionInfo {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

export function toConnectionString(info: ProjectConnectionInfo): string {
  return `postgres://${encodeURIComponent(info.user)}:${encodeURIComponent(info.password)}@${info.host}:${info.port}/${encodeURIComponent(info.database)}`;
}

/** Masked for display / API responses. The password is never included. */
export function maskConnectionInfo(info: ProjectConnectionInfo): {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
} {
  return {
    host: info.host,
    port: info.port,
    database: info.database,
    user: info.user,
    password: '••••••••',
  };
}

function redactError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  // postgres.js errors can echo host/db — strip anything credential-shaped.
  return msg
    .replace(/:[^:@/\s]+@/g, ':•••@')
    .replace(/password[^,}]*/gi, 'password=•••')
    .slice(0, 300);
}

function clientFor(info: ProjectConnectionInfo, timeoutMs: number): ReturnType<typeof postgres> {
  return postgres(toConnectionString(info), {
    max: 1,
    idle_timeout: 5,
    connect_timeout: Math.min(10, Math.max(1, Math.ceil(timeoutMs / 1000))),
    onnotice: () => undefined,
  });
}

export type LiveHealth = 'healthy' | 'unhealthy' | 'starting' | 'unavailable';

/**
 * Real liveness probe against the project database. Maps transport outcomes
 * honestly: refused/unreachable → unavailable, auth/schema errors → unhealthy.
 */
export async function checkProjectDbHealth(
  info: ProjectConnectionInfo,
  timeoutMs = 5000,
): Promise<{ health: LiveHealth; latencyMs: number }> {
  const start = Date.now();
  const sql = clientFor(info, timeoutMs);
  try {
    await sql`select 1`.simple();
    return { health: 'healthy', latencyMs: Date.now() - start };
  } catch (err) {
    const msg = redactError(err);
    if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|timeout|connect/i.test(msg)) {
      return { health: 'unavailable', latencyMs: Date.now() - start };
    }
    return { health: 'unhealthy', latencyMs: Date.now() - start };
  } finally {
    await sql.end({ timeout: 2 }).catch(() => undefined);
  }
}

// ── Guarded SQL execution (SQL editor foundation) ─────────────────────

export interface SqlGuardOptions {
  maxStatementMs: number;
  maxRows: number;
  maxLength: number;
}

export const DEFAULT_SQL_GUARDS: SqlGuardOptions = {
  maxStatementMs: 15_000,
  maxRows: 500,
  maxLength: 20_000,
};

export class SqlRejectedError extends Error {
  readonly code = 'SQL_REJECTED';
  constructor(message: string) {
    super(message);
    this.name = 'SqlRejectedError';
  }
}

const READ_LIKE = /^\s*(select|with|values|table|explain)\b/i;

/** Pure guard: single statement, bounded length. Throws SqlRejectedError. */
export function assertSafeSql(sqlText: string, maxLength: number): string {
  const trimmed = sqlText.trim().replace(/;+\s*$/, '');
  if (!trimmed) throw new SqlRejectedError('SQL statement is empty');
  if (sqlText.length > maxLength) {
    throw new SqlRejectedError(`SQL exceeds maximum length of ${maxLength} characters`);
  }
  if (/;/.test(trimmed)) {
    throw new SqlRejectedError('Only a single SQL statement is allowed per execution');
  }
  return trimmed;
}

export interface SqlResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
  durationMs: number;
}

/**
 * Execute one guarded statement against the caller's own project database.
 * Read-like statements are wrapped with LIMIT (maxRows+1) to bound memory;
 * writes run as-is under statement_timeout. Always audit-log at the call site.
 */
export async function executeProjectSql(
  info: ProjectConnectionInfo,
  sqlText: string,
  guards: SqlGuardOptions = DEFAULT_SQL_GUARDS,
): Promise<SqlResult> {
  const statement = assertSafeSql(sqlText, guards.maxLength);
  const start = Date.now();
  const sql = clientFor(info, guards.maxStatementMs + 5000);
  try {
    await sql`select set_config('statement_timeout', ${String(guards.maxStatementMs)}, true)`.simple();
    const finalSql =
      READ_LIKE.test(statement) && !/\blimit\b/i.test(statement)
        ? `SELECT * FROM (${statement}) AS cnq LIMIT ${guards.maxRows + 1}`
        : statement;
    // Single execution: result rows carry their own column names.
    const objects = (await sql.unsafe(finalSql)) as Record<string, unknown>[];
    const cols = objects.length > 0 ? Object.keys(objects[0] as object) : [];
    const truncated = objects.length > guards.maxRows;
    return {
      columns: cols,
      rows: truncated ? objects.slice(0, guards.maxRows) : objects,
      rowCount: objects.length,
      truncated,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    if (err instanceof SqlRejectedError) throw err;
    throw new Error(`SQL execution failed: ${redactError(err)}`);
  } finally {
    await sql.end({ timeout: 2 }).catch(() => undefined);
  }
}

// ── Schema inspection (real information_schema queries) ───────────────

export interface ColumnInfo {
  name: string;
  dataType: string;
  nullable: boolean;
  defaultValue: string | null;
}

export interface TableInfo {
  schema: string;
  name: string;
  columns: ColumnInfo[];
  primaryKeys: string[];
  indexes: { name: string; definition: string }[];
}

export interface ForeignKeyInfo {
  table: string;
  column: string;
  foreignTable: string;
  foreignColumn: string;
}

export interface SchemaInfo {
  tables: TableInfo[];
  foreignKeys: ForeignKeyInfo[];
}

export async function inspectProjectSchema(
  info: ProjectConnectionInfo,
  timeoutMs = 15_000,
): Promise<SchemaInfo> {
  const sql = clientFor(info, timeoutMs);
  try {
    const tables = (await sql`
      select schemaname as schema, tablename as name
      from pg_tables
      where schemaname not in ('pg_catalog', 'information_schema')
      order by schemaname, tablename
    `) as { schema: string; name: string }[];

    const columns = (await sql`
      select table_schema as "tableSchema", table_name as "tableName",
             column_name as "columnName", data_type as "dataType",
             is_nullable as "isNullable", column_default as "columnDefault"
      from information_schema.columns
      where table_schema not in ('pg_catalog', 'information_schema')
      order by table_schema, table_name, ordinal_position
    `) as {
      tableSchema: string;
      tableName: string;
      columnName: string;
      dataType: string;
      isNullable: string;
      columnDefault: string | null;
    }[];

    const pks = (await sql`
      select tc.table_schema as "tableSchema", tc.table_name as "tableName",
             kcu.column_name as "columnName"
      from information_schema.table_constraints tc
      join information_schema.key_column_usage kcu
        on tc.constraint_name = kcu.constraint_name
       and tc.table_schema = kcu.table_schema
      where tc.constraint_type = 'PRIMARY KEY'
    `) as { tableSchema: string; tableName: string; columnName: string }[];

    const idx = (await sql`
      select schemaname as schema, tablename as "tableName",
             indexname as name, indexdef as definition
      from pg_indexes
      where schemaname not in ('pg_catalog', 'information_schema')
    `) as { schema: string; tableName: string; name: string; definition: string }[];

    const fks = (await sql`
      select tc.table_schema as schema, tc.table_name as "table",
             kcu.column_name as "column",
             ccu.table_name as "foreignTable", ccu.column_name as "foreignColumn"
      from information_schema.table_constraints tc
      join information_schema.key_column_usage kcu
        on tc.constraint_name = kcu.constraint_name
       and tc.table_schema = kcu.table_schema
      join information_schema.constraint_column_usage ccu
        on ccu.constraint_name = tc.constraint_name
      where tc.constraint_type = 'FOREIGN KEY'
    `) as {
      schema: string;
      table: string;
      column: string;
      foreignTable: string;
      foreignColumn: string;
    }[];

    return {
      tables: tables.map(t => ({
        schema: t.schema,
        name: t.name,
        columns: columns
          .filter(c => c.tableSchema === t.schema && c.tableName === t.name)
          .map(c => ({
            name: c.columnName,
            dataType: c.dataType,
            nullable: c.isNullable === 'YES',
            defaultValue: c.columnDefault,
          })),
        primaryKeys: pks
          .filter(p => p.tableSchema === t.schema && p.tableName === t.name)
          .map(p => p.columnName),
        indexes: idx
          .filter(i => i.schema === t.schema && i.tableName === t.name)
          .map(i => ({ name: i.name, definition: i.definition })),
      })),
      foreignKeys: fks.map(f => ({
        table: `${f.schema}.${f.table}`,
        column: f.column,
        foreignTable: f.foreignTable,
        foreignColumn: f.foreignColumn,
      })),
    };
  } catch (err) {
    throw new Error(`Schema inspection failed: ${redactError(err)}`);
  } finally {
    await sql.end({ timeout: 2 }).catch(() => undefined);
  }
}

// ── Parameterized executor (API engine data plane) ────────────────────

/**
 * Run one parameterized statement with bound values. Identifiers must be
 * validated + quoted by the caller (see @cloudnivo/api-engine query-builder);
 * values travel as `$n` parameters only — never interpolated.
 */
export async function queryProjectDb(
  info: ProjectConnectionInfo,
  text: string,
  params: unknown[],
  timeoutMs = 15_000,
): Promise<Record<string, unknown>[]> {
  if (text.length > 20_000) throw new SqlRejectedError('SQL exceeds maximum length');
  if (params.length > 100) throw new SqlRejectedError('Too many bind parameters');
  const sql = clientFor(info, timeoutMs);
  try {
    await sql`select set_config('statement_timeout', ${String(timeoutMs)}, true)`.simple();
    const rows = (await sql.unsafe(text, params as never[])) as Record<string, unknown>[];
    return rows;
  } catch (err) {
    throw new Error(`Query failed: ${redactError(err)}`);
  } finally {
    await sql.end({ timeout: 2 }).catch(() => undefined);
  }
}

// ── Metrics (real pg statistics) ──────────────────────────────────────

export interface ProjectDbMetrics {
  version: string;
  sizeBytes: number;
  connectionCount: number;
  uptimeSeconds: number | null;
}

export async function getProjectDbMetrics(
  info: ProjectConnectionInfo,
  timeoutMs = 10_000,
): Promise<ProjectDbMetrics> {
  const sql = clientFor(info, timeoutMs);
  try {
    const ver = (await sql`select version() as v`) as unknown as { v: string }[];
    const size = (await sql`select pg_database_size(current_database()) as s`) as unknown as {
      s: string;
    }[];
    const conns =
      (await sql`select count(*) as c from pg_stat_activity where datname = current_database()`) as unknown as {
        c: string;
      }[];
    const up =
      (await sql`select extract(epoch from (now() - pg_postmaster_start_time())) as u`) as unknown as {
        u: string | null;
      }[];
    return {
      version: ver[0]?.v ?? 'unknown',
      sizeBytes: Number(size[0]?.s ?? 0),
      connectionCount: Number(conns[0]?.c ?? 0),
      uptimeSeconds: up[0]?.u == null ? null : Number(up[0].u),
    };
  } catch (err) {
    throw new Error(`Metrics collection failed: ${redactError(err)}`);
  } finally {
    await sql.end({ timeout: 2 }).catch(() => undefined);
  }
}
