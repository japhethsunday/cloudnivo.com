import { describe, expect, it } from 'vitest';
import { diffSchemas, renderMigrationPreview, type DiffSchema } from './diff.js';
import { generateTypescriptTypes, pgTypeToTs } from './types.js';
import { assertExtensionAllowed } from './introspect.js';
import { planRestore, splitSqlStatements } from './restore.js';
import { vaultDecrypt, vaultEncrypt, vaultKeyFromSecret } from './vault.js';
import { importFromPostgres } from './import.js';

const SOURCE: DiffSchema = {
  tables: [
    {
      schema: 'public',
      name: 'posts',
      columns: [
        { name: 'id', dataType: 'uuid', nullable: false, defaultValue: null },
        { name: 'title', dataType: 'text', nullable: false, defaultValue: null },
        { name: 'legacy', dataType: 'text', nullable: true, defaultValue: null },
      ],
      primaryKeys: ['id'],
    },
  ],
};

const TARGET: DiffSchema = {
  tables: [
    {
      schema: 'public',
      name: 'posts',
      columns: [
        { name: 'id', dataType: 'uuid', nullable: false, defaultValue: null },
        { name: 'title', dataType: 'character varying', nullable: false, defaultValue: null },
        { name: 'views', dataType: 'integer', nullable: false, defaultValue: '0' },
      ],
      primaryKeys: ['id'],
    },
    {
      schema: 'public',
      name: 'comments',
      columns: [{ name: 'id', dataType: 'uuid', nullable: false, defaultValue: null }],
      primaryKeys: ['id'],
    },
  ],
};

describe('schema diff', () => {
  it('detects adds, drops, and column changes with notices', () => {
    const diff = diffSchemas(SOURCE, TARGET);
    expect(diff.addedTables).toEqual(['public.comments']);
    expect(diff.removedTables).toEqual([]);
    const kinds = diff.columnChanges.map(c => c.kind).sort();
    expect(kinds).toEqual(['added', 'removed', 'type-changed']);
    const removed = diffSchemas(TARGET, SOURCE);
    expect(removed.removedTables).toEqual(['public.comments']);
    expect(removed.notices.some(n => n.includes('Destructive'))).toBe(true);
  });

  it('renders safe quoted migration previews', () => {
    const { statements } = renderMigrationPreview(SOURCE, TARGET);
    expect(statements.some(s => s.startsWith('CREATE TABLE "public"."comments"'))).toBe(true);
    expect(statements.some(s => s.includes('ADD COLUMN "views"'))).toBe(true);
    expect(statements.some(s => s.includes('DROP'))).toBe(false);
    const withDrops = renderMigrationPreview(TARGET, SOURCE, { includeDrops: true });
    expect(withDrops.statements.some(s => s.includes('-- DESTRUCTIVE'))).toBe(true);
    expect(() =>
      renderMigrationPreview({ tables: [] }, { tables: [{ schema: 'public', name: 'x; DROP', columns: [], primaryKeys: [] }] }),
    ).toThrow();
  });
});

describe('typegen', () => {
  it('maps postgres types and emits stable interfaces', () => {
    expect(pgTypeToTs('integer')).toBe('number');
    expect(pgTypeToTs('text')).toBe('string');
    expect(pgTypeToTs('boolean')).toBe('boolean');
    expect(pgTypeToTs('timestamp with time zone')).toBe('string');
    expect(pgTypeToTs('integer[]')).toBe('number[]');
    expect(pgTypeToTs('weird_custom')).toBe('unknown');
    const out = generateTypescriptTypes(TARGET);
    expect(out).toContain('export interface Posts {');
    expect(out).toContain('export interface Comments {');
    expect(out).toContain('export interface Database {');
    expect(out.indexOf('interface Comments')).toBeLessThan(out.indexOf('interface Posts'));
  });
});

describe('extensions', () => {
  it('allowlists safe extensions only', () => {
    expect(assertExtensionAllowed('pg_trgm')).toBe('pg_trgm');
    expect(() => assertExtensionAllowed('dblink')).toThrow();
    expect(() => assertExtensionAllowed('x; DROP')).toThrow();
  });
});

describe('restore guard', () => {
  it('splits dollar-quoted bodies and strings correctly', () => {
    const stmts = splitSqlStatements(`CREATE TABLE t (a text);
CREATE FUNCTION f() RETURNS void AS $$ BEGIN RAISE NOTICE 'x;y'; END; $$ LANGUAGE plpgsql;
INSERT INTO t VALUES ('a;b'), ('c');`);
    expect(stmts).toHaveLength(3);
    expect(stmts[1]).toContain('RAISE NOTICE');
  });

  it('allows data restores, denies superuser/infra scope', () => {
    expect(() => planRestore(`CREATE TABLE t (a text);\nINSERT INTO t VALUES (1);`).statements).not.toThrow();
    expect(planRestore('CREATE TABLE t (a text);').statements).toHaveLength(1);
    for (const bad of [
      'CREATE ROLE evil;',
      'ALTER ROLE x WITH SUPERUSER;',
      "COPY t FROM '/etc/passwd';",
      'CREATE FUNCTION f() RETURNS void SECURITY DEFINER AS $$ BEGIN END; $$ LANGUAGE plpgsql;',
      'ALTER TABLE t OWNER TO postgres;',
      'CREATE EXTENSION dblink;',
      'VACUUM FULL t;',
      'SET ROLE postgres;',
    ]) {
      expect(() => planRestore(bad), bad).toThrow();
    }
    // COPY ... FROM stdin (pg_dump data) is the supported data path.
    expect(() => planRestore('COPY t (a) FROM stdin;\n1\n\\.')).not.toThrow();
    expect(() => planRestore('')).toThrow();
  });
});

describe('vault crypto', () => {
  it('round-trips and rejects weak keys + wrong keys', () => {
    const key = vaultKeyFromSecret('a'.repeat(32));
    const enc = vaultEncrypt('super-secret-value', key);
    expect(enc).not.toContain('super-secret');
    expect(vaultDecrypt(enc, key)).toBe('super-secret-value');
    expect(() => vaultKeyFromSecret('short')).toThrow();
    expect(() => vaultDecrypt(enc, vaultKeyFromSecret('b'.repeat(32)))).toThrow();
  });
});

describe('postgres import validation', () => {
  const target = { host: '127.0.0.1', port: 1, database: 'db', user: 'u', password: 'p' };
  it('rejects non-postgres URLs and unsafe names before touching infra', async () => {
    await expect(importFromPostgres({ sourceUrl: 'mysql://h/db', target })).rejects.toThrow();
    await expect(importFromPostgres({ sourceUrl: 'postgres://h/evil;db', target })).rejects.toThrow();
    await expect(importFromPostgres({ sourceUrl: 'not-a-url', target })).rejects.toThrow();
  });
});
