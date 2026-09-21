import { createHash } from 'node:crypto';
import { DbToolsError } from './errors.js';
import { planRestore, splitSqlStatements } from './restore.js';

/**
 * Migration planning — the pure half of the migration workflow.
 *
 * Everything an agent needs to know about a migration BEFORE any of it
 * touches a database: how it splits into statements, which of those destroy
 * data, and what fingerprint pins the reviewed version. The API layer owns
 * persistence, approval, and transactional apply; this file owns judgement,
 * so both can be tested without a Postgres.
 */

export class MigrationRejectedError extends DbToolsError {
  constructor(message: string) {
    super('MIGRATION_REJECTED', message, 400);
  }
}

export type FindingLevel = 'info' | 'warn' | 'destructive';

export interface MigrationFinding {
  level: FindingLevel;
  /** Stable machine code — what an agent branches on. */
  code: string;
  message: string;
}

export interface MigrationPlan {
  statements: string[];
  checksum: string;
  destructive: boolean;
  findings: MigrationFinding[];
}

export const MIGRATION_MAX_BYTES = 1_000_000;
export const MIGRATION_MAX_STATEMENTS = 100;
const MIGRATION_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,118}[a-z0-9]$/;

/**
 * Destructive patterns, each with the code an agent can act on. Order
 * matters only for reporting; every match is reported.
 *
 * `ALTER … DROP COLUMN` and `DROP TABLE` are the two that silently lose
 * production data, so they are called out separately rather than folded
 * into one "destructive" flag: the remediation differs (a column can be
 * deprecated instead; a table usually cannot).
 */
const DESTRUCTIVE_RULES: { code: string; re: RegExp; message: string }[] = [
  {
    code: 'DROP_TABLE',
    re: /\bdrop\s+(?:foreign\s+)?table\b/i,
    message: 'Drops a table and every row in it. Data cannot be recovered without a backup restore.',
  },
  {
    code: 'DROP_COLUMN',
    re: /\balter\s+table\b[\s\S]*\bdrop\s+column\b/i,
    message: 'Drops a column and its data. Consider renaming it out of use first and dropping in a later migration.',
  },
  {
    code: 'DROP_SCHEMA',
    re: /\bdrop\s+schema\b/i,
    message: 'Drops a schema and everything inside it.',
  },
  {
    code: 'TRUNCATE',
    re: /\btruncate\b/i,
    message: 'Removes every row in the table. Not transaction-recoverable once committed.',
  },
  {
    code: 'DELETE_WITHOUT_WHERE',
    re: /\bdelete\s+from\s+[^;]*$/i,
    message: 'DELETE without a WHERE clause removes every row.',
  },
  {
    code: 'DROP_CONSTRAINT',
    re: /\bdrop\s+constraint\b/i,
    message: 'Drops a constraint — existing data is no longer guaranteed to satisfy it.',
  },
  {
    code: 'ALTER_COLUMN_TYPE',
    re: /\balter\s+column\b[\s\S]*\b(?:set\s+data\s+)?type\b/i,
    message: 'Changes a column type. Values that do not cast are lost or abort the migration.',
  },
  {
    code: 'DROP_INDEX',
    re: /\bdrop\s+index\b/i,
    message: 'Drops an index. Queries relying on it may degrade sharply.',
  },
];

/** Advisory (non-destructive) patterns worth telling an agent about. */
const ADVISORY_RULES: { code: string; re: RegExp; message: string }[] = [
  {
    code: 'NOT_NULL_WITHOUT_DEFAULT',
    re: /\badd\s+column\b(?![\s\S]*\bdefault\b)[\s\S]*\bnot\s+null\b/i,
    message: 'Adding a NOT NULL column without a DEFAULT fails on a non-empty table. Add a default or backfill first.',
  },
  {
    code: 'CREATE_INDEX_BLOCKING',
    re: /\bcreate\s+(?:unique\s+)?index\b(?![\s\S]*\bconcurrently\b)/i,
    message: 'CREATE INDEX takes a write lock on the table. CONCURRENTLY avoids it, but cannot run inside a transaction.',
  },
  {
    code: 'NO_RLS',
    re: /\bcreate\s+table\b/i,
    message: 'New tables have no row-level security until a policy is added. Follow up with ENABLE ROW LEVEL SECURITY and a policy.',
  },
];

/** Reject names that would be ambiguous in a filename or a log line. */
export function assertMigrationName(name: string): string {
  const trimmed = name.trim().toLowerCase();
  if (!MIGRATION_NAME_RE.test(trimmed)) {
    throw new MigrationRejectedError(
      'Migration name must be 2-120 lowercase characters: letters, digits, underscore, or hyphen (e.g. add_posts_table)',
    );
  }
  return trimmed;
}

/** sha256 over the normalised statements — what pins a reviewed migration. */
export function migrationChecksum(statements: string[]): string {
  const normalised = statements.map(s => s.replace(/\s+/g, ' ').trim()).join(';\n');
  return createHash('sha256').update(normalised, 'utf8').digest('hex');
}

/**
 * Validate migration SQL and describe what it will do.
 *
 * Reuses the restore guard for the categorical denials (roles, replication,
 * extensions, file access) so a migration cannot become a privilege
 * escalation path that the restore route already closes.
 */
export function planMigration(sqlText: string): MigrationPlan {
  if (!sqlText || !sqlText.trim()) throw new MigrationRejectedError('Migration SQL is empty');
  if (Buffer.byteLength(sqlText, 'utf8') > MIGRATION_MAX_BYTES) {
    throw new MigrationRejectedError(
      `Migration exceeds ${(MIGRATION_MAX_BYTES / 1_000_000).toFixed(0)} MB — split it into several migrations`,
    );
  }
  // Categorical denials first: reuse the restore guard so the two paths
  // cannot disagree about what is out of bounds for a tenant.
  planRestore(sqlText, { maxBytes: MIGRATION_MAX_BYTES, maxStatements: MIGRATION_MAX_STATEMENTS });
  const statements = splitSqlStatements(sqlText);
  if (statements.length === 0) throw new MigrationRejectedError('Migration SQL is empty');

  const findings: MigrationFinding[] = [];
  let destructive = false;
  for (const stmt of statements) {
    const stripped = stripComments(stmt);
    for (const rule of DESTRUCTIVE_RULES) {
      if (!rule.re.test(stripped)) continue;
      // DELETE without WHERE is the one rule that needs the negative check.
      if (rule.code === 'DELETE_WITHOUT_WHERE' && /\bwhere\b/i.test(stripped)) continue;
      destructive = true;
      findings.push({
        level: 'destructive',
        code: rule.code,
        message: `${rule.message} (${preview(stripped)})`,
      });
    }
    for (const rule of ADVISORY_RULES) {
      if (!rule.re.test(stripped)) continue;
      findings.push({ level: 'warn', code: rule.code, message: `${rule.message} (${preview(stripped)})` });
    }
  }
  if (findings.length === 0) {
    findings.push({
      level: 'info',
      code: 'CLEAN',
      message: 'No destructive operations detected. Safe to apply in any environment.',
    });
  }
  return { statements, checksum: migrationChecksum(statements), destructive, findings };
}

function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
}

function preview(sql: string): string {
  const flat = sql.replace(/\s+/g, ' ').trim();
  return flat.length > 90 ? `${flat.slice(0, 90)}…` : flat;
}

/**
 * Schema fingerprint recorded after an apply. Cheap, order-independent, and
 * enough to detect that something changed the schema outside the migration
 * trail.
 */
export function schemaFingerprint(schema: {
  tables: { schema: string; name: string; columns: { name: string; dataType: string; nullable: boolean }[] }[];
}): string {
  const lines = schema.tables
    .map(t =>
      `${t.schema}.${t.name}(${[...t.columns]
        .map(c => `${c.name}:${c.dataType}:${c.nullable ? 'null' : 'notnull'}`)
        .sort()
        .join(',')})`,
    )
    .sort();
  return createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex');
}
