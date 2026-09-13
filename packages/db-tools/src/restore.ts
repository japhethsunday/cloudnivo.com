/**
 * Guarded multi-statement SQL restore into a project database. Complements
 * the single-statement query route: migration scripts and logical dumps
 * (COPY ... FROM stdin data rows, INSERT batches, DDL) run here inside one
 * transaction with a statement timeout — any failure rolls everything back.
 *
 * Denied categorically (superuser/infra scope — use the matching platform
 * surface instead): roles, superuser flags, replication, tablespaces,
 * server config, file/program access, extensions (use /extensions),
 * SECURITY DEFINER functions, and ownership reassignment.
 */

import { DbToolsError } from './errors.js';

export class RestoreRejectedError extends DbToolsError {
  constructor(message: string) {
    super('RESTORE_REJECTED', message, 400);
  }
}

export const RESTORE_MAX_BYTES = 2_000_000;
export const RESTORE_MAX_STATEMENTS = 200;

const FORBIDDEN_RE = new RegExp(
  [
    String.raw`\bcreate\s+(role|user|tablespace|database|subscription|publication|server|extension)\b`,
    String.raw`\bdrop\s+(role|user|tablespace|database|subscription|server|extension)\b`,
    String.raw`\b(superuser|nosuperuser|replication|bypassrls)\b`,
    String.raw`\balter\s+(role|user|system|database\s+\w+\s+owner)\b`,
    String.raw`\bcopy\b[^;]*\bfrom\s+(?!stdin\b)`,
    String.raw`\bcopy\b[^;]*\b(program|stdout|stdin\s*\\\.)`,
    String.raw`\bsecurity\s+definer\b`,
    String.raw`\bowner\s+to\b`,
    String.raw`\b(load|checkpoint|cluster|reindex|vacuum|discard)\b`,
    String.raw`\b(set\s+(session\s+authorization|role)\b|reset\s+role\b)`,
    String.raw`(?:^|\n)\s*\\(connect|c|set|timing)\b`,
  ].join('|'),
  'im',
);

/**
 * Split SQL text into statements, respecting single/double-quoted strings,
 * line/block comments, and dollar-quoted bodies ($$...$$, $tag$...$tag$).
 */
export function splitSqlStatements(sqlText: string): string[] {
  const out: string[] = [];
  let current = '';
  let i = 0;
  const n = sqlText.length;
  let quote: string | null = null;
  let dollarTag: string | null = null;
  while (i < n) {
    const ch = sqlText[i] as string;
    if (dollarTag !== null) {
      if (sqlText.startsWith(dollarTag, i)) {
        current += dollarTag;
        i += dollarTag.length;
        dollarTag = null;
        continue;
      }
      current += ch;
      i += 1;
      continue;
    }
    if (quote !== null) {
      current += ch;
      if (ch === quote) {
        // '' inside a '...' string is an escaped quote, not the terminator.
        if (sqlText[i + 1] === quote) {
          current += sqlText[i + 1] as string;
          i += 2;
          continue;
        }
        quote = null;
      }
      i += 1;
      continue;
    }
    if (ch === '-' && sqlText[i + 1] === '-') {
      const end = sqlText.indexOf('\n', i);
      current += sqlText.slice(i, end === -1 ? n : end);
      i = end === -1 ? n : end;
      continue;
    }
    if (ch === '/' && sqlText[i + 1] === '*') {
      const end = sqlText.indexOf('*/', i + 2);
      current += sqlText.slice(i, end === -1 ? n : end + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      i += 1;
      continue;
    }
    if (ch === '$') {
      const m = /^\$[a-zA-Z_][a-zA-Z0-9_]*\$|^\$\$/.exec(sqlText.slice(i));
      if (m) {
        dollarTag = m[0];
        current += dollarTag;
        i += dollarTag.length;
        continue;
      }
      current += ch;
      i += 1;
      continue;
    }
    if (ch === ';') {
      const stmt = current.trim();
      if (stmt) out.push(stmt);
      current = '';
      i += 1;
      continue;
    }
    current += ch;
    i += 1;
  }
  const tail = current.trim();
  if (tail) out.push(tail);
  return out;
}

export interface RestorePlan {
  statements: string[];
}

export function planRestore(
  sqlText: string,
  limits: { maxBytes?: number; maxStatements?: number } = {},
): RestorePlan {
  const maxBytes = limits.maxBytes ?? RESTORE_MAX_BYTES;
  const maxStatements = limits.maxStatements ?? RESTORE_MAX_STATEMENTS;
  if (!sqlText || !sqlText.trim()) throw new RestoreRejectedError('Restore script is empty');
  if (Buffer.byteLength(sqlText, 'utf8') > maxBytes) {
    throw new RestoreRejectedError(
      `Restore script exceeds ${(maxBytes / 1_000_000).toFixed(0)} MB — split it or use pg_restore via CLI`,
    );
  }
  const statements = splitSqlStatements(sqlText);
  if (statements.length === 0) throw new RestoreRejectedError('Restore script is empty');
  if (statements.length > maxStatements) {
    throw new RestoreRejectedError(
      `Too many statements (${statements.length} > ${maxStatements}) — split the script`,
    );
  }
  for (const stmt of statements) {
    if (FORBIDDEN_RE.test(stmt)) {
      throw new RestoreRejectedError(
        `Forbidden statement in restore script: ${stmt.slice(0, 80)} — use the matching platform surface (extensions, roles, and replication are managed by CloudNivo)`,
      );
    }
  }
  return { statements };
}
