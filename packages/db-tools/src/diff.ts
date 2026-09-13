/**
 * Schema / migration diff: compare two inspected schemas (current vs branch,
 * staging vs production, or any two snapshots) and preview the migration DDL
 * that converges source → target. Pure functions — no database access.
 *
 * Scope is structural (tables/columns/nullability/defaults/PKs). Index and
 * constraint diffs are reported as notices, not DDL, because safe index
 * migration needs CONCURRENTLY + locking analysis the preview cannot verify.
 */

export interface DiffColumn {
  name: string;
  dataType: string;
  nullable: boolean;
  defaultValue: string | null;
}

export interface DiffTable {
  schema: string;
  name: string;
  columns: DiffColumn[];
  primaryKeys: string[];
}

export interface DiffSchema {
  tables: DiffTable[];
}

export interface ColumnChange {
  table: string;
  column: string;
  kind: 'added' | 'removed' | 'type-changed' | 'nullability-changed' | 'default-changed';
  from: string | null;
  to: string | null;
}

export interface SchemaDiff {
  addedTables: string[];
  removedTables: string[];
  columnChanges: ColumnChange[];
  notices: string[];
}

const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;

function tableKey(schema: string, name: string): string {
  return `${schema}.${name}`;
}

function quoteIdent(value: string): string {
  if (!IDENT_RE.test(value)) throw new Error(`Unsafe identifier: ${value.slice(0, 60)}`);
  return `"${value}"`;
}

function normalizeType(t: string): string {
  return t.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function diffSchemas(source: DiffSchema, target: DiffSchema): SchemaDiff {
  const notices: string[] = [];
  const sMap = new Map(source.tables.map(t => [tableKey(t.schema, t.name), t]));
  const tMap = new Map(target.tables.map(t => [tableKey(t.schema, t.name), t]));
  const addedTables = [...tMap.keys()].filter(k => !sMap.has(k));
  const removedTables = [...sMap.keys()].filter(k => !tMap.has(k));
  const columnChanges: ColumnChange[] = [];
  for (const [key, sTable] of sMap) {
    const tTable = tMap.get(key);
    if (!tTable) continue;
    const sCols = new Map(sTable.columns.map(c => [c.name, c]));
    const tCols = new Map(tTable.columns.map(c => [c.name, c]));
    for (const [name, tCol] of tCols) {
      const sCol = sCols.get(name);
      if (!sCol) {
        columnChanges.push({
          table: key,
          column: name,
          kind: 'added',
          from: null,
          to: `${tCol.dataType}${tCol.nullable ? '' : ' NOT NULL'}`,
        });
        continue;
      }
      if (normalizeType(sCol.dataType) !== normalizeType(tCol.dataType)) {
        columnChanges.push({
          table: key,
          column: name,
          kind: 'type-changed',
          from: sCol.dataType,
          to: tCol.dataType,
        });
      } else if (sCol.nullable !== tCol.nullable) {
        columnChanges.push({
          table: key,
          column: name,
          kind: 'nullability-changed',
          from: sCol.nullable ? 'NULL' : 'NOT NULL',
          to: tCol.nullable ? 'NULL' : 'NOT NULL',
        });
      } else if ((sCol.defaultValue ?? null) !== (tCol.defaultValue ?? null)) {
        columnChanges.push({
          table: key,
          column: name,
          kind: 'default-changed',
          from: sCol.defaultValue,
          to: tCol.defaultValue,
        });
      }
    }
    for (const name of sCols.keys()) {
      if (!tCols.has(name)) {
        columnChanges.push({ table: key, column: name, kind: 'removed', from: sCols.get(name)?.dataType ?? null, to: null });
      }
    }
    const sPk = [...sTable.primaryKeys].sort().join(',');
    const tPk = [...tTable.primaryKeys].sort().join(',');
    if (sPk !== tPk) {
      notices.push(`Primary key changed on ${key} (${sPk || 'none'} → ${tPk || 'none'}): review manually, not auto-migrated`);
    }
  }
  if (removedTables.length > 0) {
    notices.push(
      `Destructive: ${removedTables.length} table(s) would be dropped (${removedTables.slice(0, 5).join(', ')}). Require explicit confirmation.`,
    );
  }
  return { addedTables, removedTables, columnChanges, notices };
}

function columnDdl(col: DiffColumn): string {
  const parts = [quoteIdent(col.name), col.dataType];
  if (!col.nullable) parts.push('NOT NULL');
  if (col.defaultValue) parts.push(`DEFAULT ${col.defaultValue}`);
  return parts.join(' ');
}

/**
 * Render a forward migration preview (source → target). Destructive drops
 * are included but clearly marked — the API requires explicit confirmation
 * to apply them. Statements are individually safe-quoted; identifiers that
 * fail validation abort the preview instead of emitting bad DDL.
 */
export function renderMigrationPreview(
  source: DiffSchema,
  target: DiffSchema,
  opts: { includeDrops?: boolean } = {},
): { statements: string[]; diff: SchemaDiff } {
  const diff = diffSchemas(source, target);
  const statements: string[] = [];
  const tMap = new Map(target.tables.map(t => [tableKey(t.schema, t.name), t]));
  for (const key of diff.addedTables) {
    const table = tMap.get(key);
    if (!table) continue;
    const [schema, ...rest] = key.split('.');
    const name = rest.join('.');
    const cols = table.columns.map(columnDdl).join(', ');
    const pk =
      table.primaryKeys.length > 0
        ? `, PRIMARY KEY (${table.primaryKeys.map(quoteIdent).join(', ')})`
        : '';
    statements.push(`CREATE TABLE ${quoteIdent(schema as string)}.${quoteIdent(name)} (${cols}${pk});`);
  }
  for (const change of diff.columnChanges) {
    const [schema, ...rest] = change.table.split('.');
    const name = rest.join('.');
    const target_ = `${quoteIdent(schema as string)}.${quoteIdent(name)}`;
    if (change.kind === 'added' && change.to) {
      const tTable = tMap.get(change.table);
      const col = tTable?.columns.find(c => c.name === change.column);
      if (col) statements.push(`ALTER TABLE ${target_} ADD COLUMN ${columnDdl(col)};`);
    } else if (change.kind === 'removed' && opts.includeDrops) {
      statements.push(`ALTER TABLE ${target_} DROP COLUMN ${quoteIdent(change.column)}; -- DESTRUCTIVE`);
    } else if (change.kind === 'type-changed' && change.to) {
      statements.push(
        `ALTER TABLE ${target_} ALTER COLUMN ${quoteIdent(change.column)} TYPE ${change.to} USING ${quoteIdent(change.column)}::${change.to};`,
      );
    } else if (change.kind === 'nullability-changed') {
      statements.push(
        change.to === 'NOT NULL'
          ? `ALTER TABLE ${target_} ALTER COLUMN ${quoteIdent(change.column)} SET NOT NULL;`
          : `ALTER TABLE ${target_} ALTER COLUMN ${quoteIdent(change.column)} DROP NOT NULL;`,
      );
    } else if (change.kind === 'default-changed') {
      statements.push(
        change.to
          ? `ALTER TABLE ${target_} ALTER COLUMN ${quoteIdent(change.column)} SET DEFAULT ${change.to};`
          : `ALTER TABLE ${target_} ALTER COLUMN ${quoteIdent(change.column)} DROP DEFAULT;`,
      );
    }
  }
  if (opts.includeDrops) {
    for (const key of diff.removedTables) {
      const [schema, ...rest] = key.split('.');
      statements.push(
        `DROP TABLE ${quoteIdent(schema as string)}.${quoteIdent(rest.join('.'))}; -- DESTRUCTIVE`,
      );
    }
  }
  return { statements, diff };
}
