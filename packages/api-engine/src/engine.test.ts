import { describe, expect, it } from 'vitest';
import type { SchemaInfo } from '@cloudnivo/database';
import {
  buildDelete,
  buildGet,
  buildInsert,
  buildList,
  buildUpdate,
  parseFilters,
  parseOrder,
  primaryKeyColumn,
  resolveTable,
} from './query-builder.js';
import { CachingIntrospectionService } from './introspection.js';
import { DataEngine } from './engine.js';
import type { EngineError } from './query-builder.js';

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (err) {
    expect((err as EngineError).code).toBe(code);
    return;
  }
  expect.unreachable(`expected ${code}`);
}

const snapshot: SchemaInfo = {
  tables: [
    {
      schema: 'public',
      name: 'users',
      columns: [
        { name: 'id', dataType: 'uuid', nullable: false, defaultValue: null },
        { name: 'email', dataType: 'character varying', nullable: false, defaultValue: null },
        { name: 'age', dataType: 'integer', nullable: true, defaultValue: null },
      ],
      primaryKeys: ['id'],
      indexes: [],
    },
    {
      schema: 'public',
      name: 'posts',
      columns: [
        { name: 'id', dataType: 'uuid', nullable: false, defaultValue: null },
        { name: 'user_id', dataType: 'uuid', nullable: false, defaultValue: null },
        { name: 'title', dataType: 'text', nullable: false, defaultValue: null },
      ],
      primaryKeys: ['id'],
      indexes: [],
    },
    {
      schema: 'public',
      name: 'no_pk',
      columns: [{ name: 'v', dataType: 'text', nullable: true, defaultValue: null }],
      primaryKeys: [],
      indexes: [],
    },
  ],
  foreignKeys: [
    { table: 'public.posts', column: 'user_id', foreignTable: 'users', foreignColumn: 'id' },
  ],
};

describe('query-builder identifiers', () => {
  it('resolves tables from the snapshot, rejects unknowns', () => {
    expect(resolveTable(snapshot, 'users').qualified).toBe('"public"."users"');
    expectCode(() => resolveTable(snapshot, 'admin_secrets'), 'TABLE_NOT_FOUND');
    expect(() => resolveTable(snapshot, 'users; DROP TABLE users')).toThrow();
    expect(() => resolveTable(snapshot, 'pg_catalog.pg_authid')).toThrow(/not found/i);
  });

  it('blocks identifier injection in columns, order, select', () => {
    expect(() => buildList(snapshot, 'users', { filters: ['id=eq.1;DROP'] })).not.toThrow();
    for (const bad of ['email, (select password)', 'email" FROM "users', '* FROM users--']) {
      expect(() => buildList(snapshot, 'users', { select: bad })).toThrow();
    }
    expect(() => parseOrder('email.desc;DROP')).toThrow();
    expect(() => parseOrder('nope.asc')).not.toThrow(); // validated at build time
    expectCode(() => buildList(snapshot, 'users', { order: 'nope.asc' }), 'INVALID_COLUMN');
  });

  it('parameterizes every value (no interpolation)', () => {
    const q = buildList(snapshot, 'users', {
      filters: ["email=eq.a'b@c.d", 'age=gt.3'],
      order: 'email.desc',
      limit: 5,
      offset: 10,
    });
    expect(q.text).toContain('"public"."users"');
    expect(q.text).toContain('"email" = $1');
    expect(q.text).not.toContain("a'b@c.d");
    expect(q.params).toEqual(["a'b@c.d", '3', 5, 10]);
  });

  it('rejects mass assignment and unknown fields', () => {
    expectCode(
      () => buildInsert(snapshot, 'users', { email: 'a@b.c', is_admin: true } as never),
      'INVALID_FIELD',
    );
    expectCode(() => buildInsert(snapshot, 'users', {}), 'EMPTY_BODY');
    expect(() => buildUpdate(snapshot, 'users', '1', { id: '2', email: 'x' })).not.toThrow();
    // pk change is dropped, not applied:
    const u = buildUpdate(snapshot, 'users', '1', { id: '2', email: 'x' });
    expect(u.text).not.toContain('SET "id"');
  });

  it('requires single-column PKs for item routes', () => {
    expect(primaryKeyColumn(snapshot.tables[0] as never)).toBe('id');
    expectCode(() => buildGet(snapshot, 'no_pk', '1'), 'NO_SINGLE_PK');
  });

  it('builds safe pagination bounds', () => {
    expectCode(() => buildList(snapshot, 'users', { limit: 0 }), 'INVALID_PAGINATION');
    expect(() => buildList(snapshot, 'users', { limit: 10_000, maxLimit: 500 })).toThrow();
    expect(() => buildList(snapshot, 'users', { offset: -1 })).toThrow();
    expect(buildDelete(snapshot, 'users', 'abc')).toEqual({
      text: 'DELETE FROM "public"."users" WHERE "id" = $1',
      params: ['abc'],
    });
  });

  it('parses strict filter grammar only', () => {
    expect(parseFilters([])).toEqual([]);
    expect(() => parseFilters(['email==x'])).toThrow();
    expect(() => parseFilters(['email=bogus.x'])).toThrow();
    expect(() => parseFilters(['email=is.maybe'])).not.toThrow(); // parsed; validated at build
    expect(() => buildList(snapshot, 'users', { filters: ['email=is.maybe'] })).toThrow();
    expect(() => parseFilters(new Array(11).fill('a=eq.b'))).toThrow(/Too many/);
  });
});

describe('introspection cache', () => {
  it('caches snapshots and invalidates', async () => {
    let reads = 0;
    const svc = new CachingIntrospectionService(
      {
        read: async () => {
          reads += 1;
          return snapshot;
        },
      },
      60_000,
    );
    expect((await svc.getTables()).length).toBe(3);
    expect((await svc.getTables()).length).toBe(3);
    expect(reads).toBe(1);
    expect(await svc.getPrimaryKeys('users')).toEqual(['id']);
    expect(await svc.getForeignKeys()).toHaveLength(1);
    svc.invalidate();
    await svc.getSchema();
    expect(reads).toBe(2);
  });
});

describe('data engine with fake executor', () => {
  function fakeDb() {
    const rows: Record<string, Record<string, unknown>[]> = {
      users: [{ id: 'u1', email: 'a@b.c', age: 30 }],
    };
    const exec = async (text: string, params: unknown[]): Promise<Record<string, unknown>[]> => {
      if (text.startsWith('SELECT')) {
        const table = /FROM "public"\."(\w+)"/.exec(text)?.[1] ?? '';
        let out = [...(rows[table] ?? [])];
        const whereId = /WHERE "id" = \$1/.test(text) ? (params[0] as string) : null;
        if (whereId) out = out.filter(r => r['id'] === whereId);
        return out;
      }
      if (text.startsWith('INSERT')) {
        const m = /INTO "public"\."(\w+)" \(([^)]+)\)/.exec(text);
        const table = m?.[1] ?? '';
        const cols = (m?.[2] ?? '').split(',').map(s => s.replace(/"/g, '').trim());
        const row: Record<string, unknown> = {};
        cols.forEach((c, i) => {
          row[c] = params[i];
        });
        (rows[table] ??= []).push(row);
        return [row];
      }
      if (text.startsWith('UPDATE')) {
        const id = params[params.length - 1] as string;
        const row = rows['users']?.find(r => r['id'] === id);
        if (!row) return [];
        row['email'] = params[0];
        return [row];
      }
      if (text.startsWith('DELETE')) {
        const id = params[0] as string;
        const i = (rows['users'] ?? []).findIndex(r => r['id'] === id);
        if (i === -1) return [];
        rows['users']?.splice(i, 1);
        return [{ id }];
      }
      throw new Error(`unexpected: ${text}`);
    };
    return { exec, rows };
  }

  it('runs list/get/create/update/remove end-to-end', async () => {
    const { exec } = fakeDb();
    const engine = new DataEngine(exec);
    expect((await engine.list(snapshot, 'users', {})).rows).toHaveLength(1);
    expect(await engine.get(snapshot, 'users', 'u1')).toMatchObject({ email: 'a@b.c' });
    await expect(engine.get(snapshot, 'users', 'missing')).rejects.toMatchObject({
      code: 'ROW_NOT_FOUND',
    });
    const created = await engine.create(snapshot, 'users', { id: 'u2', email: 'b@c.d' });
    expect(created['id']).toBe('u2');
    const updated = await engine.update(snapshot, 'users', 'u2', { email: 'c@d.e' });
    expect(updated['email']).toBe('c@d.e');
    await engine.remove(snapshot, 'users', 'u2');
    await expect(engine.get(snapshot, 'users', 'u2')).rejects.toMatchObject({
      code: 'ROW_NOT_FOUND',
    });
  });
});
