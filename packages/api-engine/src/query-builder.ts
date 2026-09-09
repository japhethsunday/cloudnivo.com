import type { SchemaInfo, TableInfo } from '@cloudnivo/database';

/**
 * Pure, side-effect-free query builder — the injection firewall.
 *
 * Invariants (unit-tested, no DB required):
 * - Table/column identifiers ONLY come from the live introspected snapshot
 *   (allow-list). Anything else → EngineError, never SQL.
 * - User values ONLY travel as `$n` bind parameters. Identifiers are quoted.
 * - Filters/sorts/pagination are parsed from a strict grammar — unknown
 *   operators, excess keys, and out-of-range limits are rejected, not clamped
 *   silently (except documented defaults).
 */

export class EngineError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
    this.status = status;
  }
}

export interface BuiltQuery {
  text: string;
  params: unknown[];
}

const IDENT = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export interface ResolvedTable {
  schema: string;
  table: TableInfo;
  qualified: string;
}

/** Resolve `users` (→ public.users) or `schema.table` against the snapshot. */
export function resolveTable(snapshot: SchemaInfo, ref: string): ResolvedTable {
  const parts = ref.split('.');
  if (parts.length > 2 || parts.some(p => !p || !IDENT.test(p))) {
    throw new EngineError('INVALID_TABLE', 'Invalid table reference');
  }
  const [schema, name] =
    parts.length === 2 ? [parts[0] as string, parts[1] as string] : ['public', parts[0] as string];
  const table = snapshot.tables.find(t => t.schema === schema && t.name === name);
  // Generic message: never echo the raw reference (it arrives from the URL).
  if (!table) throw new EngineError('TABLE_NOT_FOUND', 'Table not found', 404);
  return { schema, table, qualified: `${quoteIdent(schema)}.${quoteIdent(name)}` };
}

function resolveColumn(table: TableInfo, col: string): string {
  if (!IDENT.test(col) || !table.columns.some(c => c.name === col)) {
    throw new EngineError('INVALID_COLUMN', `Invalid column: ${col}`);
  }
  return quoteIdent(col);
}

export function primaryKeyColumn(table: TableInfo): string {
  if (table.primaryKeys.length !== 1 || !table.primaryKeys[0]) {
    throw new EngineError(
      'NO_SINGLE_PK',
      `Table ${table.name} has no single-column primary key; item routes unavailable`,
      400,
    );
  }
  return table.primaryKeys[0];
}

// ── Filters: col=op.value, repeatable ─────────────────────────────────

const FILTER_OPS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'in', 'is'] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

export interface Filter {
  column: string;
  op: FilterOp;
  value: string;
}

const FILTER_RE = /^([A-Za-z_][A-Za-z0-9_]{0,62})=(eq|neq|gt|gte|lt|lte|like|ilike|in|is)\.(.*)$/s;

export function parseFilters(raw: string[]): Filter[] {
  if (raw.length > 10) throw new EngineError('INVALID_FILTER', 'Too many filters (max 10)');
  return raw.map(f => {
    const m = FILTER_RE.exec(f);
    if (!m || m[1] === undefined || m[2] === undefined || m[3] === undefined) {
      throw new EngineError(
        'INVALID_FILTER',
        `Bad filter "${f.slice(0, 80)}" (expected column=op.value)`,
      );
    }
    if (m[3].length > 500) throw new EngineError('INVALID_FILTER', 'Filter value too long');
    if (!(FILTER_OPS as readonly string[]).includes(m[2])) {
      throw new EngineError('INVALID_FILTER', 'Unknown filter operator');
    }
    return { column: m[1], op: m[2] as FilterOp, value: m[3] };
  });
}

function filterSql(table: TableInfo, f: Filter, params: unknown[]): string {
  const col = resolveColumn(table, f.column);
  const push = (v: unknown): string => {
    params.push(v);
    return `$${params.length}`;
  };
  switch (f.op) {
    case 'eq':
      return `${col} = ${push(f.value)}`;
    case 'neq':
      return `${col} <> ${push(f.value)}`;
    case 'gt':
      return `${col} > ${push(f.value)}`;
    case 'gte':
      return `${col} >= ${push(f.value)}`;
    case 'lt':
      return `${col} < ${push(f.value)}`;
    case 'lte':
      return `${col} <= ${push(f.value)}`;
    case 'like':
      return `${col} LIKE ${push(f.value)}`;
    case 'ilike':
      return `${col} ILIKE ${push(f.value)}`;
    case 'in': {
      const vals = f.value.split(',').slice(0, 50);
      if (vals.length === 0) throw new EngineError('INVALID_FILTER', 'Empty in-list');
      return `${col} IN (${vals.map(v => push(v)).join(', ')})`;
    }
    case 'is':
      if (f.value === 'null') return `${col} IS NULL`;
      if (f.value === 'notnull') return `${col} IS NOT NULL`;
      if (f.value === 'true') return `${col} IS TRUE`;
      if (f.value === 'false') return `${col} IS FALSE`;
      throw new EngineError('INVALID_FILTER', 'is. expects null|notnull|true|false');
  }
}

// ── Sort: col.asc|col.desc, max 3 ─────────────────────────────────────

export function parseOrder(raw: string | null): { column: string; desc: boolean }[] {
  if (!raw) return [];
  const keys = raw.split(',').slice(0, 3);
  if (raw.split(',').length > 3)
    throw new EngineError('INVALID_ORDER', 'Too many sort keys (max 3)');
  return keys.map(k => {
    const m = /^([A-Za-z_][A-Za-z0-9_]{0,62})\.(asc|desc)$/.exec(k);
    if (!m || !m[1] || !m[2])
      throw new EngineError('INVALID_ORDER', `Bad sort key "${k.slice(0, 60)}"`);
    return { column: m[1], desc: m[2] === 'desc' };
  });
}

// ── SELECT ────────────────────────────────────────────────────────────

export interface ListOptions {
  select?: string | null;
  filters?: string[];
  order?: string | null;
  limit?: number;
  offset?: number;
  maxLimit?: number;
}

export function buildList(snapshot: SchemaInfo, tableRef: string, opts: ListOptions): BuiltQuery {
  const { table, qualified } = resolveTable(snapshot, tableRef);
  const maxLimit = opts.maxLimit ?? 500;
  const limit = opts.limit ?? 20;
  const offset = opts.offset ?? 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > maxLimit) {
    throw new EngineError('INVALID_PAGINATION', `limit must be 1–${maxLimit}`);
  }
  if (!Number.isInteger(offset) || offset < 0 || offset > 1_000_000) {
    throw new EngineError('INVALID_PAGINATION', 'offset must be 0–1000000');
  }
  const cols = opts.select
    ? opts.select.split(',').map(c => resolveColumn(table, c.trim()))
    : ['*'];
  if (cols.length > 50) throw new EngineError('INVALID_SELECT', 'Too many columns (max 50)');
  const params: unknown[] = [];
  const where = parseFilters(opts.filters ?? []).map(f => filterSql(table, f, params));
  const order = parseOrder(opts.order ?? null).map(
    o => `${resolveColumn(table, o.column)} ${o.desc ? 'DESC' : 'ASC'}`,
  );
  const parts = [`SELECT ${cols.join(', ')} FROM ${qualified}`];
  if (where.length > 0) parts.push(`WHERE ${where.join(' AND ')}`);
  if (order.length > 0) parts.push(`ORDER BY ${order.join(', ')}`);
  params.push(limit, offset);
  parts.push(`LIMIT $${params.length - 1} OFFSET $${params.length}`);
  return { text: parts.join(' '), params };
}

export function buildGet(snapshot: SchemaInfo, tableRef: string, id: string): BuiltQuery {
  const { table, qualified } = resolveTable(snapshot, tableRef);
  const pk = primaryKeyColumn(table);
  if (id.length > 500) throw new EngineError('INVALID_ID', 'Row id too long');
  return { text: `SELECT * FROM ${qualified} WHERE ${quoteIdent(pk)} = $1`, params: [id] };
}

// ── INSERT / UPDATE / DELETE ──────────────────────────────────────────

function writableColumns(table: TableInfo, body: Record<string, unknown>): [string, unknown][] {
  const names = Object.keys(body);
  if (names.length === 0) throw new EngineError('EMPTY_BODY', 'Request body must not be empty');
  if (names.length > 50) throw new EngineError('BODY_TOO_LARGE', 'Too many fields (max 50)');
  const known = new Set(table.columns.map(c => c.name));
  const pk = table.primaryKeys.length === 1 ? table.primaryKeys[0] : null;
  return names.map(name => {
    if (!IDENT.test(name) || !known.has(name)) {
      throw new EngineError('INVALID_FIELD', `Unknown field: ${name.slice(0, 60)}`);
    }
    if (name === pk && body[name] === undefined) {
      throw new EngineError('INVALID_FIELD', 'Primary key must have a value');
    }
    const value = body[name];
    if (typeof value === 'string' && value.length > 100_000) {
      throw new EngineError('FIELD_TOO_LARGE', `Field ${name} too large`);
    }
    if (value !== null && typeof value === 'object') {
      throw new EngineError('INVALID_FIELD', `Field ${name} must be a scalar or null`);
    }
    return [name, value] as [string, unknown];
  });
}

export function buildInsert(
  snapshot: SchemaInfo,
  tableRef: string,
  body: Record<string, unknown>,
): BuiltQuery {
  const { table, qualified } = resolveTable(snapshot, tableRef);
  const entries = writableColumns(table, body);
  const cols = entries.map(([n]) => quoteIdent(n));
  const vals = entries.map((_, i) => `$${i + 1}`);
  return {
    text: `INSERT INTO ${qualified} (${cols.join(', ')}) VALUES (${vals.join(', ')}) RETURNING *`,
    params: entries.map(([, v]) => v),
  };
}

export function buildUpdate(
  snapshot: SchemaInfo,
  tableRef: string,
  id: string,
  body: Record<string, unknown>,
): BuiltQuery {
  const { table, qualified } = resolveTable(snapshot, tableRef);
  const pk = primaryKeyColumn(table);
  const entries = writableColumns(table, body).filter(([n]) => n !== pk);
  if (entries.length === 0) throw new EngineError('EMPTY_BODY', 'No updatable fields provided');
  if (id.length > 500) throw new EngineError('INVALID_ID', 'Row id too long');
  const sets = entries.map(([n], i) => `${quoteIdent(n)} = $${i + 1}`);
  return {
    text: `UPDATE ${qualified} SET ${sets.join(', ')} WHERE ${quoteIdent(pk)} = $${entries.length + 1} RETURNING *`,
    params: [...entries.map(([, v]) => v), id],
  };
}

export function buildDelete(snapshot: SchemaInfo, tableRef: string, id: string): BuiltQuery {
  const { table, qualified } = resolveTable(snapshot, tableRef);
  const pk = primaryKeyColumn(table);
  if (id.length > 500) throw new EngineError('INVALID_ID', 'Row id too long');
  return { text: `DELETE FROM ${qualified} WHERE ${quoteIdent(pk)} = $1`, params: [id] };
}

/** Relationships declared by real FK constraints (read-only metadata). */
export function relationshipsOf(
  snapshot: SchemaInfo,
  tableRef: string,
): { column: string; references: string }[] {
  const { table } = resolveTable(snapshot, tableRef);
  return snapshot.foreignKeys
    .filter(fk => fk.table === `public.${table.name}` || fk.table.endsWith(`.${table.name}`))
    .map(fk => ({ column: fk.column, references: `${fk.foreignTable}.${fk.foreignColumn}` }));
}
