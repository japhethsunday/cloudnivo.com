import { createHash, randomUUID } from 'node:crypto';
import type { AIPlan, PlanTable } from './plan.js';

/**
 * Migration generation from validated schema definitions. SQL is BUILT from
 * structured objects with allow-listed identifiers — model text is never
 * concatenated into statements. Each migration is checksummed, ordered, and
 * traceable through pending → approved → executing → executed/failed (with
 * best-effort inverse statements for rollback of created tables).
 */

const IDENT = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;

function ident(name: string, what: string): string {
  if (!IDENT.test(name)) throw new Error(`Invalid ${what}: ${name.slice(0, 60)}`);
  return `"${name}"`;
}

const PG_TYPES: Record<string, string> = {
  uuid: 'uuid',
  text: 'text',
  integer: 'integer',
  bigint: 'bigint',
  boolean: 'boolean',
  timestamptz: 'timestamptz',
  date: 'date',
  numeric: 'numeric',
  jsonb: 'jsonb',
};

function columnSql(col: {
  name: string;
  type: string;
  nullable: boolean;
  unique?: boolean;
  default?: string;
}): string {
  const pgType = PG_TYPES[col.type];
  if (!pgType) throw new Error(`Unsupported column type: ${col.type}`);
  if (col.default !== undefined && /;/.test(col.default))
    throw new Error('Column default must not contain semicolons');
  let out = `${ident(col.name, 'column')} ${pgType}`;
  if (!col.nullable) out += ' NOT NULL';
  if (col.unique) out += ' UNIQUE';
  if (col.name === 'id' && col.type === 'uuid') out += ' DEFAULT gen_random_uuid()';
  if (col.name === 'created_at' && col.type === 'timestamptz') out += ' DEFAULT now()';
  return out;
}

export function createTableSql(table: PlanTable): string {
  const cols = table.columns.map(columnSql);
  if (table.primaryKey.length > 0) {
    cols.push(
      `PRIMARY KEY (${table.primaryKey.map(c => ident(c, 'primary-key column')).join(', ')})`,
    );
  }
  return `CREATE TABLE IF NOT EXISTS "public".${ident(table.name, 'table')} (\n  ${cols.join(',\n  ')}\n);`;
}

export function addForeignKeySql(rel: {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
  onDelete: string;
}): string {
  const onDelete =
    rel.onDelete === 'cascade' ? 'CASCADE' : rel.onDelete === 'set null' ? 'SET NULL' : 'RESTRICT';
  // RESTRICT is the default — emit NO ACTION clause for it.
  const clause = onDelete === 'RESTRICT' ? '' : ` ON DELETE ${onDelete}`;
  const name = `cn_ai_${rel.fromTable}_${rel.fromColumn}`.slice(0, 60);
  return (
    `ALTER TABLE "public".${ident(rel.fromTable, 'table')} ` +
    `ADD CONSTRAINT ${ident(name, 'constraint')} FOREIGN KEY (${ident(rel.fromColumn, 'column')}) ` +
    `REFERENCES "public".${ident(rel.toTable, 'table')} (${ident(rel.toColumn, 'column')})${clause};`
  );
}

export function createIndexSql(ix: { table: string; columns: string[]; unique: boolean }): string {
  const name = `cn_ai_${ix.table}_${ix.columns.join('_')}`.slice(0, 60);
  return (
    `CREATE ${ix.unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS ${ident(name, 'index')} ` +
    `ON "public".${ident(ix.table, 'table')} (${ix.columns.map(c => ident(c, 'index column')).join(', ')});`
  );
}

export type MigrationStatus =
  'pending' | 'approved' | 'executing' | 'executed' | 'failed' | 'rolled_back';

export interface Migration {
  id: string;
  planId: string;
  projectId: string;
  statements: string[];
  /** Inverse statements for best-effort rollback (DROP created tables, reverse order). */
  rollbackStatements: string[];
  checksum: string;
  status: MigrationStatus;
  error: string | null;
  createdAt: string;
  executedAt: string | null;
}

/** Build an ordered, checksummed migration from a validated plan. */
export function buildMigration(plan: AIPlan, planId: string, projectId: string): Migration {
  const statements: string[] = [];
  for (const t of plan.database.tables) statements.push(createTableSql(t));
  for (const r of plan.database.relationships) statements.push(addForeignKeySql(r));
  for (const ix of plan.database.indexes) statements.push(createIndexSql(ix));
  const rollbackStatements = [...plan.database.tables]
    .reverse()
    .map(t => `DROP TABLE IF EXISTS "public".${ident(t.name, 'table')};`);
  const checksum = createHash('sha256').update(statements.join('\n'), 'utf8').digest('hex');
  return {
    id: randomUUID(),
    planId,
    projectId,
    statements,
    rollbackStatements,
    checksum,
    status: 'pending',
    error: null,
    createdAt: new Date().toISOString(),
    executedAt: null,
  };
}

/** Render a safe preview: statements only, no secrets, bounded length. */
export function renderPreview(m: Migration): string[] {
  return m.statements.map(s => s.slice(0, 500));
}
