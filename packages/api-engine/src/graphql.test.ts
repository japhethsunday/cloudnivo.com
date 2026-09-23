import { describe, expect, it } from 'vitest';
import type { SchemaInfo } from '@cloudnivo/database';
import { DataEngine } from './engine.js';
import { buildGraphQLSchema, runGraphQL, type GraphQLContext } from './graphql.js';

/**
 * GraphQL is a second front door onto the same rows. The property that
 * matters is that it cannot become a second authorization system: whatever
 * REST would refuse, this must refuse too.
 *
 * The executor below records every statement, so the tests assert on the SQL
 * that actually reached the database rather than on the resolver's return.
 */

const snapshot: SchemaInfo = {
  tables: [
    {
      schema: 'public',
      name: 'posts',
      columns: [
        { name: 'id', dataType: 'uuid', nullable: false, defaultValue: null },
        { name: 'user_id', dataType: 'uuid', nullable: false, defaultValue: null },
        { name: 'title', dataType: 'text', nullable: false, defaultValue: null },
        { name: 'views', dataType: 'integer', nullable: true, defaultValue: null },
        { name: 'huge', dataType: 'bigint', nullable: true, defaultValue: null },
        { name: 'meta', dataType: 'jsonb', nullable: true, defaultValue: null },
      ],
      primaryKeys: ['id'],
      indexes: [],
    },
  ],
  foreignKeys: [],
};

function harness(over: Partial<GraphQLContext> = {}) {
  const statements: { text: string; params: unknown[] }[] = [];
  const rows = [
    { id: 'p1', user_id: 'u1', title: 'Mine', views: 3, huge: '9007199254740993', meta: { a: 1 } },
  ];
  const engine = new DataEngine(async (text, params) => {
    statements.push({ text, params });
    if (text.startsWith('DELETE')) return [];
    return rows;
  });
  const ctx: GraphQLContext = {
    engine,
    snapshot,
    filtersFor: () => [],
    canWrite: true,
    maxLimit: 500,
    ...over,
  };
  const schema = buildGraphQLSchema(snapshot);
  return { schema, ctx, statements };
}

describe('schema generation', () => {
  it('exposes a query, a by_pk lookup and mutations per table', async () => {
    const { schema, ctx } = harness();
    const res = await runGraphQL(
      schema,
      { query: '{ __schema { queryType { fields { name } } mutationType { fields { name } } } }' },
      ctx,
    );
    const data = res.data as {
      __schema: {
        queryType: { fields: { name: string }[] };
        mutationType: { fields: { name: string }[] };
      };
    };
    expect(data.__schema.queryType.fields.map(f => f.name)).toEqual(
      expect.arrayContaining(['posts', 'posts_by_pk']),
    );
    expect(data.__schema.mutationType.fields.map(f => f.name)).toEqual(
      expect.arrayContaining(['insert_posts', 'update_posts_by_pk', 'delete_posts_by_pk']),
    );
  });

  it('carries bigint as a string, so values above 2^53 survive', async () => {
    const { schema, ctx } = harness();
    const res = await runGraphQL(schema, { query: '{ posts { huge } }' }, ctx);
    expect((res.data as { posts: { huge: string }[] }).posts[0]?.huge).toBe('9007199254740993');
  });

  it('returns jsonb as structured JSON', async () => {
    const { schema, ctx } = harness();
    const res = await runGraphQL(schema, { query: '{ posts { meta } }' }, ctx);
    expect((res.data as { posts: { meta: unknown }[] }).posts[0]?.meta).toEqual({ a: 1 });
  });

  it('rejects a query naming a table or column that does not exist', async () => {
    const { schema, ctx } = harness();
    for (const q of ['{ secrets { id } }', '{ posts { password } }']) {
      const res = await runGraphQL(schema, { query: q }, ctx);
      expect(res.errors?.length, q).toBeGreaterThan(0);
      expect(res.data, q).toBeUndefined();
    }
  });
});

describe('row scoping cannot be escaped', () => {
  const scoped = { filtersFor: () => ['user_id=eq.u1'] };

  it('applies the identity filter to a list query', async () => {
    const { schema, ctx, statements } = harness(scoped);
    await runGraphQL(schema, { query: '{ posts { id } }' }, ctx);
    expect(statements[0]?.params).toContain('u1');
  });

  it('applies it to by_pk, which would otherwise key on the id alone', async () => {
    const { schema, ctx, statements } = harness(scoped);
    await runGraphQL(schema, { query: '{ posts_by_pk(id: "p9") { id } }' }, ctx);
    // Both the owner and the requested id must be bound.
    expect(statements[0]?.params).toContain('u1');
    expect(statements[0]?.params).toContain('p9');
  });

  it('keeps the identity filter when the query supplies its own where', async () => {
    const { schema, ctx, statements } = harness(scoped);
    await runGraphQL(schema, { query: '{ posts(where: { user_id: { eq: "u2" } }) { id } }' }, ctx);
    // u1 is still bound: a caller cannot displace their own scope by asking
    // for someone else's rows.
    expect(statements[0]?.params).toContain('u1');
    expect(statements[0]?.params).toContain('u2');
  });

  it('refuses to update or delete a row the caller cannot see', async () => {
    const statements: { text: string; params: unknown[] }[] = [];
    const engine = new DataEngine(async (text, params) => {
      statements.push({ text, params });
      return []; // nothing visible under the owner filter
    });
    const ctx: GraphQLContext = {
      engine,
      snapshot,
      filtersFor: () => ['user_id=eq.u1'],
      canWrite: true,
      maxLimit: 500,
    };
    const schema = buildGraphQLSchema(snapshot);

    const upd = await runGraphQL(
      schema,
      { query: 'mutation { update_posts_by_pk(id: "p9", set: { title: "hacked" }) { id } }' },
      ctx,
    );
    expect(upd.errors?.[0]?.message).toMatch(/not found/i);
    expect(statements.some(s => s.text.startsWith('UPDATE'))).toBe(false);

    const del = await runGraphQL(
      schema,
      { query: 'mutation { delete_posts_by_pk(id: "p9") }' },
      ctx,
    );
    expect(del.errors?.[0]?.message).toMatch(/not found/i);
    expect(statements.some(s => s.text.startsWith('DELETE'))).toBe(false);
  });
});

describe('write permission', () => {
  it('refuses every mutation for a read-only caller', async () => {
    const { schema, ctx, statements } = harness({ canWrite: false });
    for (const q of [
      'mutation { insert_posts(object: { title: "x" }) { id } }',
      'mutation { update_posts_by_pk(id: "p1", set: { title: "x" }) { id } }',
      'mutation { delete_posts_by_pk(id: "p1") }',
    ]) {
      const res = await runGraphQL(schema, { query: q }, ctx);
      expect(res.errors?.[0]?.message, q).toMatch(/read-only/);
    }
    expect(statements).toHaveLength(0);
  });
});

describe('cost and input limits', () => {
  it('caps limit at the context maximum however large the query asks for', async () => {
    const { schema, ctx, statements } = harness({ maxLimit: 50 });
    await runGraphQL(schema, { query: '{ posts(limit: 100000) { id } }' }, ctx);
    // The builder binds LIMIT as a parameter rather than inlining it, so the
    // cap shows up in params, not in the statement text.
    expect(statements[0]?.text).toContain('LIMIT $');
    expect(statements[0]?.params).toContain(50);
  });

  it('refuses an oversized document before parsing it', async () => {
    const { schema, ctx, statements } = harness();
    const res = await runGraphQL(schema, { query: `{ posts { ${'id '.repeat(20_000)} } }` }, ctx);
    expect(res.errors?.[0]?.message).toMatch(/too large/);
    expect(statements).toHaveLength(0);
  });

  it('refuses an empty or unparseable document', async () => {
    const { schema, ctx } = harness();
    expect((await runGraphQL(schema, { query: '' }, ctx)).errors).toBeTruthy();
    expect((await runGraphQL(schema, { query: '{{{' }, ctx)).errors).toBeTruthy();
  });

  it('refuses an unknown filter operator rather than passing it through', async () => {
    const { schema, ctx } = harness();
    const res = await runGraphQL(
      schema,
      { query: '{ posts(where: { title: { eq: "x" } }) { id } }' },
      ctx,
    );
    // eq is known, so this one succeeds; the unknown-operator path is
    // enforced by the input type, which rejects the field outright.
    expect(res.errors).toBeUndefined();
    const bad = await runGraphQL(
      schema,
      { query: '{ posts(where: { title: { sqlinject: "x" } }) { id } }' },
      ctx,
    );
    expect(bad.errors?.length).toBeGreaterThan(0);
  });
});

describe('values never become SQL', () => {
  it('binds a filter value containing SQL syntax as a parameter', async () => {
    const { schema, ctx, statements } = harness();
    const nasty = "x'; DROP TABLE posts;--";
    await runGraphQL(
      schema,
      { query: '{ posts(where: { title: { eq: $t } }) { id } }', variables: { t: nasty } },
      ctx,
    );
    // The document above has no variable definition, so it fails validation;
    // repeat with a proper operation to exercise the binding path.
    const ok = await runGraphQL(
      schema,
      {
        query: 'query Q($t: String) { posts(where: { title: { eq: $t } }) { id } }',
        variables: { t: nasty },
      },
      ctx,
    );
    expect(ok.errors).toBeUndefined();
    const last = statements[statements.length - 1];
    expect(last?.text).not.toContain('DROP TABLE');
    expect(last?.params).toContain(nasty);
  });
});

describe('an empty database', () => {
  it('produces a valid schema instead of failing to construct', async () => {
    const empty: SchemaInfo = { tables: [], foreignKeys: [] };
    const schema = buildGraphQLSchema(empty);
    const engine = new DataEngine(async () => []);
    const res = await runGraphQL(
      schema,
      { query: '{ _empty }' },
      { engine, snapshot: empty, filtersFor: () => [], canWrite: false, maxLimit: 100 },
    );
    expect(res.errors).toBeUndefined();
  });
});
