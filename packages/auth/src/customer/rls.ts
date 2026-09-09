/**
 * Row-Level Security foundation — two cooperating layers:
 *
 * 1. Engine enforcement (active now): the API layer injects owner scoping
 *    into every customer query (`ownerScope()`), unless the caller is admin
 *    or service_role. No frontend filtering, ever.
 * 2. Database policies (generated SQL, applied where the provider allows):
 *    real Postgres RLS as defense-in-depth, managed via SQL below today and
 *    via the dashboard in a future phase.
 *
 * Convention: a table with a `user_id` column is owner-scoped. Tables without
 * one are project-open to any authorized caller of the project.
 */

export type RlsOperation = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';

export interface RlsPolicy {
  table: string;
  operation: RlsOperation;
  /** SQL predicate, e.g. `user_id = current_setting('app.user_id')::uuid`. */
  using: string;
  withCheck?: string;
}

const IDENT = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;

function ident(name: string, what: string): string {
  if (!IDENT.test(name)) throw new Error(`Invalid ${what}: ${name.slice(0, 60)}`);
  return `"${name}"`;
}

/** Standard owner-scoped policy set for one table (service_role bypasses). */
export function ownerPolicies(schema: string, table: string, ownerColumn = 'user_id'): RlsPolicy[] {
  const name = `${schema}.${table}`;
  const col = ident(ownerColumn, 'column');
  const owner = `${col} = current_setting('app.user_id', true)::uuid`;
  const isService = `current_setting('app.role', true) = 'service_role'`;
  return [
    { table: name, operation: 'SELECT', using: `(${owner} OR ${isService})` },
    { table: name, operation: 'INSERT', using: 'true', withCheck: `(${owner} OR ${isService})` },
    {
      table: name,
      operation: 'UPDATE',
      using: `(${owner} OR ${isService})`,
      withCheck: `(${owner} OR ${isService})`,
    },
    { table: name, operation: 'DELETE', using: `(${owner} OR ${isService})` },
  ];
}

/** Render policies to executable SQL (parameter-free, identifiers validated). */
export function policiesToSql(schema: string, table: string, ownerColumn = 'user_id'): string[] {
  const q = `${ident(schema, 'schema')}.${ident(table, 'table')}`;
  const safe = table.replace(/[^a-zA-Z0-9_]/g, '_');
  return [
    `ALTER TABLE ${q} ENABLE ROW LEVEL SECURITY`,
    ...ownerPolicies(schema, table, ownerColumn).map(
      p =>
        `CREATE POLICY "cn_${safe}_${p.operation.toLowerCase()}" ON ${q} FOR ${p.operation} TO PUBLIC USING (${p.using})` +
        (p.withCheck ? ` WITH CHECK (${p.withCheck})` : ''),
    ),
  ];
}

/** Per-connection request context for RLS session vars (call after connect). */
export function requestContextSql(
  userId: string,
  role: string,
): { text: string; params: unknown[] } {
  if (!/^[0-9a-f-]{36}$/i.test(userId)) throw new Error('Invalid user id for RLS context');
  if (!['authenticated', 'admin', 'service_role', 'anonymous'].includes(role)) {
    throw new Error('Invalid role for RLS context');
  }
  return {
    text: `SELECT set_config('app.user_id', $1, true), set_config('app.role', $2, true)`,
    params: [userId, role],
  };
}

export interface OwnerScope {
  column: string;
  userId: string;
}

/**
 * Engine-level owner scoping: returns the filter to inject when a
 * non-privileged customer hits a table carrying a `user_id` column.
 * Returns null when the table is not owner-scoped (project-open).
 */
export function ownerScope(
  tableColumns: string[],
  role: string,
  userId: string,
  ownerColumn = 'user_id',
): OwnerScope | null {
  if (role === 'admin' || role === 'service_role') return null;
  if (!tableColumns.includes(ownerColumn)) return null;
  return { column: ownerColumn, userId };
}
