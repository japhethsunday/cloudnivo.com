import { describe, expect, it } from 'vitest';
import {
  EXTENSION_ALLOWLIST,
  MAX_SEARCH_LIMIT,
  MAX_VECTOR_DIMENSIONS,
  planSearch,
  planVectorIndex,
  toVectorLiteral,
} from './index.js';

/**
 * These plans run against TENANT databases, so the property that matters is
 * that nothing a caller sends can reach the statement except as a bound
 * parameter. Most of what follows is that one property, approached from the
 * angles an attacker would actually try.
 */

const VEC = [0.1, -0.2, 0.3];

describe('nothing caller-supplied reaches the SQL text', () => {
  it('binds the embedding as a single parameter, never inline', () => {
    const plan = planSearch({
      table: 'docs',
      mode: 'semantic',
      vector: VEC,
      vectorColumn: 'embedding',
    });
    expect(plan.text).not.toContain('0.1');
    expect(plan.params).toContain('[0.1,-0.2,0.3]');
  });

  it('binds the query text as a parameter', () => {
    const plan = planSearch({
      table: 'docs',
      mode: 'keyword',
      query: "robert'); DROP TABLE students;--",
      textColumns: ['body'],
    });
    expect(plan.text).not.toContain('DROP TABLE');
    expect(plan.params).toContain("robert'); DROP TABLE students;--");
  });

  it('refuses an injected identifier rather than quoting it through', () => {
    for (const bad of ['docs; DROP TABLE users', 'docs"', "docs'", 'docs--', '1docs', '']) {
      expect(() =>
        planSearch({ table: bad, mode: 'keyword', query: 'x', textColumns: ['body'] }),
      ).toThrow();
    }
  });

  it('refuses an injected select, vector or text column', () => {
    const base = {
      table: 'docs',
      mode: 'semantic' as const,
      vector: VEC,
      vectorColumn: 'embedding',
    };
    expect(() => planSearch({ ...base, select: ['id', 'x; DROP TABLE t'] })).toThrow();
    expect(() => planSearch({ ...base, vectorColumn: 'e"mbed' })).toThrow();
    expect(() =>
      planSearch({
        table: 'docs',
        mode: 'keyword',
        query: 'x',
        textColumns: ['body; DROP TABLE t'],
      }),
    ).toThrow();
  });

  it('refuses a filter predicate carrying a terminator or comment', () => {
    // The API layer builds this from identity, never from request input. If a
    // future call site wires caller input in, it must fail here.
    for (const bad of ['user_id = $1; DROP TABLE t', 'user_id = $1 -- x', 'user_id = $1 /* x */']) {
      expect(() =>
        planSearch({
          table: 'docs',
          mode: 'semantic',
          vector: VEC,
          vectorColumn: 'embedding',
          filterSql: bad,
          filterParams: ['u1'],
        }),
      ).toThrow();
    }
  });

  it('refuses an unknown metric or text configuration', () => {
    const base = {
      table: 'docs',
      mode: 'semantic' as const,
      vector: VEC,
      vectorColumn: 'embedding',
    };
    expect(() => planSearch({ ...base, metric: 'evil' as never })).toThrow();
    expect(() =>
      planSearch({
        table: 'docs',
        mode: 'keyword',
        query: 'x',
        textColumns: ['b'],
        textConfig: 'evil',
      }),
    ).toThrow();
  });
});

describe('embedding validation', () => {
  it('rejects a non-finite or non-numeric entry', () => {
    for (const bad of [[1, Number.NaN], [1, Infinity], [1, 'x'], []]) {
      expect(() => toVectorLiteral(bad)).toThrow();
    }
  });

  it('rejects an embedding large enough to be a memory attack', () => {
    expect(() => toVectorLiteral(new Array(MAX_VECTOR_DIMENSIONS + 1).fill(0))).toThrow();
    expect(() => toVectorLiteral(new Array(MAX_VECTOR_DIMENSIONS).fill(0))).not.toThrow();
  });
});

describe('plan shape', () => {
  it('orders semantic search by the operator for the requested metric', () => {
    const ops = { cosine: '<=>', l2: '<->', inner_product: '<#>' } as const;
    for (const [metric, op] of Object.entries(ops)) {
      const plan = planSearch({
        table: 'docs',
        mode: 'semantic',
        vector: VEC,
        vectorColumn: 'embedding',
        metric: metric as keyof typeof ops,
      });
      expect(plan.text).toContain(`ORDER BY "embedding" ${op}`);
    }
  });

  it('caps the limit so one request cannot drain a table', () => {
    const plan = planSearch({
      table: 'docs',
      mode: 'semantic',
      vector: VEC,
      vectorColumn: 'embedding',
      limit: 10_000,
    });
    expect(plan.limit).toBe(MAX_SEARCH_LIMIT);
    expect(plan.params).toContain(MAX_SEARCH_LIMIT);
  });

  it('rejects a limit that is not a positive integer', () => {
    for (const bad of [0, -1, 1.5, 'x']) {
      expect(() =>
        planSearch({
          table: 'docs',
          mode: 'semantic',
          vector: VEC,
          vectorColumn: 'embedding',
          limit: bad as number,
        }),
      ).toThrow();
    }
  });

  it('applies the ownership filter in hybrid mode to BOTH sides of the fusion', () => {
    // A row excluded from one side but not the other would leak through the
    // full outer join — the filter has to bind on each branch.
    const plan = planSearch({
      table: 'docs',
      mode: 'hybrid',
      vector: VEC,
      vectorColumn: 'embedding',
      query: 'hello',
      textColumns: ['body'],
      filterSql: 'user_id = $1',
      filterParams: ['u1'],
    });
    expect(plan.text.match(/user_id = \$1/g)?.length).toBe(2);
    expect(plan.params[0]).toBe('u1');
  });

  it('coalesces text columns so a NULL does not void the document', () => {
    const plan = planSearch({
      table: 'docs',
      mode: 'keyword',
      query: 'x',
      textColumns: ['title', 'body'],
    });
    expect(plan.text).toContain(`coalesce("title", '')`);
    expect(plan.text).toContain(`coalesce("body", '')`);
  });

  it('requires the inputs each mode actually needs', () => {
    expect(() => planSearch({ table: 'docs', mode: 'semantic' })).toThrow();
    expect(() => planSearch({ table: 'docs', mode: 'keyword', query: 'x' })).toThrow();
    expect(() =>
      planSearch({ table: 'docs', mode: 'hybrid', vector: VEC, vectorColumn: 'e' }),
    ).toThrow();
    expect(() => planSearch({ table: 'docs', mode: 'nope' as never })).toThrow();
  });
});

describe('index DDL', () => {
  it('builds hnsw by default and ivfflat on request, with the metric opclass', () => {
    expect(planVectorIndex({ table: 'docs', column: 'embedding' })).toContain(
      'USING hnsw ("embedding" vector_cosine_ops)',
    );
    expect(
      planVectorIndex({ table: 'docs', column: 'embedding', metric: 'l2', type: 'ivfflat' }),
    ).toContain('USING ivfflat ("embedding" vector_l2_ops) WITH (lists = 100)');
  });

  it('refuses injected identifiers and an out-of-range list count', () => {
    expect(() => planVectorIndex({ table: 'docs; DROP TABLE t', column: 'e' })).toThrow();
    expect(() =>
      planVectorIndex({ table: 'docs', column: 'e', type: 'ivfflat', lists: 0 }),
    ).toThrow();
    expect(() =>
      planVectorIndex({ table: 'docs', column: 'e', type: 'ivfflat', lists: 99_999 }),
    ).toThrow();
  });
});

describe('the extension is installable', () => {
  it('allowlists vector, or none of the above can run', () => {
    expect(EXTENSION_ALLOWLIST.has('vector')).toBe(true);
  });
});
