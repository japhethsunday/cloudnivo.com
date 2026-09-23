import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { planSearch, planVectorIndex } from './vector-search.js';

/**
 * The planner's unit tests prove what the SQL *says*. This proves Postgres
 * accepts it and returns what we claim — the part no amount of string
 * assertion can establish.
 *
 * Needs LIVE_PG_URL pointing at a database where `CREATE EXTENSION vector`
 * succeeds (pgvector installed). Skipped otherwise, like the other .live
 * suites.
 */

const LIVE_PG_URL = process.env['LIVE_PG_URL'] ?? '';

describe.skipIf(!LIVE_PG_URL)('vector search on live postgres', () => {
  let sql: ReturnType<typeof postgres>;
  const exec = (text: string, params: unknown[]): Promise<Record<string, unknown>[]> =>
    sql.unsafe(text, params as never[]) as unknown as Promise<Record<string, unknown>[]>;

  const titles = async (req: Parameters<typeof planSearch>[0]): Promise<string[]> => {
    const plan = planSearch(req);
    const rows = await exec(plan.text, plan.params);
    return rows.map(r => String(r['title']));
  };

  beforeAll(async () => {
    sql = postgres(LIVE_PG_URL, { onnotice: () => {} });
    await exec('CREATE EXTENSION IF NOT EXISTS vector', []);
    await exec('DROP TABLE IF EXISTS cn_vec_test', []);
    await exec(
      `CREATE TABLE cn_vec_test (
         id serial primary key, user_id text, title text, body text, embedding vector(3))`,
      [],
    );
    await exec(
      `INSERT INTO cn_vec_test (user_id,title,body,embedding) VALUES
         ('u1','cats','the cat sat on the mat','[1,0,0]'),
         ('u1','dogs','the dog barked loudly','[0,1,0]'),
         ('u2','secret','private cat document','[1,0,0.1]'),
         ('u1','birds','a bird sang','[0,0,1]')`,
      [],
    );
  });

  afterAll(async () => {
    if (!sql) return;
    await exec('DROP TABLE IF EXISTS cn_vec_test', []);
    await sql.end();
  });

  it('emits index DDL Postgres actually accepts', async () => {
    // Wrong opclass or syntax fails here rather than on a customer's table.
    await expect(
      exec(planVectorIndex({ table: 'cn_vec_test', column: 'embedding', metric: 'cosine' }), []),
    ).resolves.toBeDefined();
    await expect(
      exec(
        planVectorIndex({
          table: 'cn_vec_test',
          column: 'embedding',
          metric: 'l2',
          type: 'ivfflat',
          lists: 10,
        }),
        [],
      ),
    ).resolves.toBeDefined();
  });

  it('returns the nearest neighbour first, with a distance', async () => {
    const plan = planSearch({
      table: 'cn_vec_test',
      mode: 'semantic',
      vector: [1, 0, 0],
      vectorColumn: 'embedding',
      select: ['title'],
      limit: 2,
    });
    const rows = await exec(plan.text, plan.params);
    expect(rows[0]?.['title']).toBe('cats');
    expect(rows[0]?.['distance']).toBeDefined();
  });

  it('matches only the row containing the keyword', async () => {
    expect(
      await titles({
        table: 'cn_vec_test',
        mode: 'keyword',
        query: 'barked',
        textColumns: ['title', 'body'],
        select: ['title'],
      }),
    ).toEqual(['dogs']);
  });

  it('fuses both rankings and returns a score', async () => {
    const plan = planSearch({
      table: 'cn_vec_test',
      mode: 'hybrid',
      vector: [1, 0, 0],
      vectorColumn: 'embedding',
      query: 'cat',
      textColumns: ['title', 'body'],
      select: ['title'],
      limit: 3,
    });
    const rows = await exec(plan.text, plan.params);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.['score']).toBeDefined();
  });

  /**
   * The one that matters. A vector index does not know about row ownership,
   * and the hybrid plan reaches the table through a FULL OUTER JOIN of two
   * subqueries — a filter applied to only one branch would leak.
   */
  it.each(['semantic', 'keyword', 'hybrid'] as const)(
    "never returns another owner's row in %s mode",
    async mode => {
      const got = await titles({
        table: 'cn_vec_test',
        mode,
        vector: [1, 0, 0.1],
        vectorColumn: 'embedding',
        query: 'cat',
        textColumns: ['title', 'body'],
        select: ['title'],
        filterSql: 'user_id = $1',
        filterParams: ['u1'],
        limit: 10,
      });
      expect(got).not.toContain('secret');
    },
  );

  it('control: the same search WITHOUT the filter does return that row', async () => {
    // Without this, the test above would pass even if `secret` were simply
    // unreachable — proving nothing about the filter.
    const got = await titles({
      table: 'cn_vec_test',
      mode: 'hybrid',
      vector: [1, 0, 0.1],
      vectorColumn: 'embedding',
      query: 'cat',
      textColumns: ['title', 'body'],
      select: ['title'],
      limit: 10,
    });
    expect(got).toContain('secret');
  });
});
