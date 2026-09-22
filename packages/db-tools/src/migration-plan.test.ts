import { describe, expect, it } from 'vitest';
import {
  assertMigrationName,
  migrationChecksum,
  planMigration,
  schemaFingerprint,
  MigrationRejectedError,
} from './migration-plan.js';

describe('migration planning', () => {
  it('splits statements and pins a checksum', () => {
    const plan = planMigration(
      'create table posts (id uuid primary key, title text);\ncreate index posts_title_idx on posts (title);',
    );
    expect(plan.statements).toHaveLength(2);
    expect(plan.checksum).toMatch(/^[0-9a-f]{64}$/);
    // Whitespace must not change the identity of a reviewed migration.
    expect(migrationChecksum(['create table posts (id uuid)'])).toBe(
      migrationChecksum(['create   table\n posts (id uuid)']),
    );
  });

  it('flags every destructive operation with an actionable code', () => {
    const cases: [string, string][] = [
      ['drop table posts', 'DROP_TABLE'],
      ['alter table posts drop column title', 'DROP_COLUMN'],
      ['truncate posts', 'TRUNCATE'],
      ['delete from posts', 'DELETE_WITHOUT_WHERE'],
      ['drop schema app cascade', 'DROP_SCHEMA'],
      ['alter table posts alter column id type text', 'ALTER_COLUMN_TYPE'],
    ];
    for (const [sql, code] of cases) {
      const plan = planMigration(sql);
      expect(plan.destructive, sql).toBe(true);
      expect(plan.findings.map(f => f.code), sql).toContain(code);
    }
  });

  it('does not flag a scoped DELETE as unbounded', () => {
    const plan = planMigration("delete from posts where id = '1'");
    expect(plan.findings.map(f => f.code)).not.toContain('DELETE_WITHOUT_WHERE');
  });

  it('reports advisories without marking the migration destructive', () => {
    const plan = planMigration('alter table posts add column body text not null');
    expect(plan.destructive).toBe(false);
    expect(plan.findings.map(f => f.code)).toContain('NOT_NULL_WITHOUT_DEFAULT');
  });

  it('reports a clean migration explicitly rather than silently', () => {
    const plan = planMigration('alter table posts add column body text default \'\'');
    expect(plan.destructive).toBe(false);
    expect(plan.findings).toEqual([
      expect.objectContaining({ level: 'info', code: 'CLEAN' }),
    ]);
  });

  it('refuses privilege escalation that the restore guard already denies', () => {
    expect(() => planMigration('create role attacker superuser')).toThrow();
    expect(() => planMigration('alter role app with superuser')).toThrow();
    expect(() => planMigration('create extension pg_cron')).toThrow();
  });

  it('refuses empty and oversized migrations', () => {
    expect(() => planMigration('   ')).toThrow(MigrationRejectedError);
    expect(() => planMigration(`select 1;`.repeat(200))).toThrow(/Too many statements|statements/);
  });

  it('normalises and validates migration names', () => {
    expect(assertMigrationName('  Add_Posts_Table ')).toBe('add_posts_table');
    expect(() => assertMigrationName('a')).toThrow(MigrationRejectedError);
    expect(() => assertMigrationName('drop; rm -rf')).toThrow(MigrationRejectedError);
  });

  it('fingerprints a schema independently of column order', () => {
    const a = {
      tables: [
        {
          schema: 'public',
          name: 't',
          columns: [
            { name: 'a', dataType: 'text', nullable: true },
            { name: 'b', dataType: 'int', nullable: false },
          ],
        },
      ],
    };
    const b = {
      tables: [
        {
          schema: 'public',
          name: 't',
          columns: [
            { name: 'b', dataType: 'int', nullable: false },
            { name: 'a', dataType: 'text', nullable: true },
          ],
        },
      ],
    };
    expect(schemaFingerprint(a)).toBe(schemaFingerprint(b));
    // A real change must move the fingerprint.
    expect(
      schemaFingerprint({
        tables: [
          { schema: 'public', name: 't', columns: [{ name: 'a', dataType: 'text', nullable: false }] },
        ],
      }),
    ).not.toBe(schemaFingerprint(a));
  });
});
