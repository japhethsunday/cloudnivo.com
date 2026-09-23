import {
  GraphQLBoolean,
  GraphQLFloat,
  GraphQLID,
  GraphQLInt,
  GraphQLInputObjectType,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLScalarType,
  GraphQLSchema,
  GraphQLString,
  Kind,
  parse,
  validate,
  execute,
  specifiedRules,
  type DocumentNode,
  type GraphQLFieldConfigMap,
  type GraphQLOutputType,
} from 'graphql';
import type { SchemaInfo, TableInfo } from '@cloudnivo/database';
import { EngineError } from './query-builder.js';
import type { DataEngine } from './engine.js';

/**
 * GraphQL over the same data plane as REST.
 *
 * The schema is derived from the live introspected snapshot, and every
 * resolver goes through DataEngine — the same builder, the same identifier
 * allow-list, the same bind-parameter discipline. That is the point: a second
 * query language must not become a second authorization system, which is how
 * a GraphQL endpoint ends up bypassing the row filters REST applies.
 *
 * Row scoping arrives in the context as `filters`, built by the API layer
 * from the caller's identity exactly as it is for REST, and is concatenated
 * with (never replaced by) anything the query asks for.
 *
 * Relations are deliberately NOT generated. Nested resolvers over a
 * per-request connection are an N+1 without a dataloader, and a join whose
 * far side skips the owner filter is a data leak. Until both are handled
 * properly, one table per query is the honest surface.
 */

export const GraphQLJSON = new GraphQLScalarType({
  name: 'JSON',
  description: 'Arbitrary JSON, as stored in a json/jsonb column.',
  serialize: v => v,
  parseValue: v => v,
  parseLiteral(ast) {
    // Literals are converted structurally; anything unrecognised becomes null
    // rather than leaking an AST node into a query parameter.
    const walk = (node: unknown): unknown => {
      const n = node as { kind?: string; value?: unknown; values?: unknown[]; fields?: unknown[] };
      switch (n.kind) {
        case Kind.INT:
          return parseInt(String(n.value), 10);
        case Kind.FLOAT:
          return parseFloat(String(n.value));
        case Kind.STRING:
        case Kind.BOOLEAN:
          return n.value;
        case Kind.NULL:
          return null;
        case Kind.LIST:
          return (n.values ?? []).map(walk);
        case Kind.OBJECT:
          return Object.fromEntries(
            (n.fields as { name: { value: string }; value: unknown }[]).map(f => [
              f.name.value,
              walk(f.value),
            ]),
          );
        default:
          return null;
      }
    };
    return walk(ast);
  },
});

/** Postgres type → GraphQL scalar. */
function scalarFor(dataType: string): GraphQLOutputType {
  const t = dataType.toLowerCase();
  if (t === 'boolean') return GraphQLBoolean;
  if (t === 'smallint' || t === 'integer') return GraphQLInt;
  // bigint exceeds IEEE-754 integer range, so it travels as a string rather
  // than silently losing precision above 2^53.
  if (t === 'bigint') return GraphQLString;
  if (t.startsWith('numeric') || t.startsWith('decimal') || t === 'real' || t.includes('double')) {
    return GraphQLFloat;
  }
  if (t === 'json' || t === 'jsonb') return GraphQLJSON;
  return GraphQLString;
}

/**
 * GraphQL names allow [_A-Za-z][_0-9A-Za-z]*. A Postgres identifier can hold
 * characters GraphQL cannot express, and such a table is skipped rather than
 * renamed: a silent rename produces a schema whose names do not match the
 * database, which is worse than an absence.
 */
const GQL_NAME = /^[_A-Za-z][_0-9A-Za-z]*$/;

export interface GraphQLContext {
  engine: DataEngine;
  snapshot: SchemaInfo;
  /**
   * Row filters from the caller's identity, per table.
   *
   * Per table rather than one global list because ownership is a property of
   * the table: `user_id=eq.<id>` is meaningful only where that column exists,
   * and applying it blindly to a table without one would error instead of
   * filtering. The API layer reuses the same resolver REST uses.
   */
  filtersFor: (table: string) => string[];
  /** False for read-only callers; mutations then refuse. */
  canWrite: boolean;
  /** Ceiling for any single selection. */
  maxLimit: number;
}

function rowType(table: TableInfo): GraphQLObjectType {
  return new GraphQLObjectType({
    name: table.name,
    fields: () => {
      const fields: GraphQLFieldConfigMap<Record<string, unknown>, GraphQLContext> = {};
      for (const col of table.columns) {
        if (!GQL_NAME.test(col.name)) continue;
        const isPk = table.primaryKeys.includes(col.name);
        const base = isPk ? GraphQLID : scalarFor(col.dataType);
        fields[col.name] = {
          type: col.nullable || !isPk ? base : new GraphQLNonNull(base),
          description: col.dataType,
          resolve: src => src[col.name] ?? null,
        };
      }
      return fields;
    },
  });
}

function inputType(table: TableInfo, name: string): GraphQLInputObjectType {
  return new GraphQLInputObjectType({
    name,
    fields: () => {
      const fields: Record<string, { type: GraphQLOutputType; description: string }> = {};
      for (const col of table.columns) {
        if (!GQL_NAME.test(col.name)) continue;
        fields[col.name] = { type: scalarFor(col.dataType) as never, description: col.dataType };
      }
      return fields as never;
    },
  });
}

/**
 * Turn GraphQL `where` input into the builder's filter grammar.
 *
 * Every value stays a value: the builder parses `col=op.value` and binds the
 * value as `$n`, so nothing here can become SQL. Unknown operators are
 * rejected by the builder rather than passed through.
 */
const WHERE_OPS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'is'] as const;

function whereToFilters(where: Record<string, unknown> | null | undefined): string[] {
  if (!where) return [];
  const out: string[] = [];
  for (const [column, spec] of Object.entries(where)) {
    if (spec === null || typeof spec !== 'object') continue;
    for (const [op, value] of Object.entries(spec as Record<string, unknown>)) {
      if (!(WHERE_OPS as readonly string[]).includes(op)) {
        throw new EngineError('VALIDATION_ERROR', `Unknown filter operator: ${op}`, 400);
      }
      out.push(`${column}=${op}.${String(value)}`);
    }
  }
  return out;
}

function whereInput(table: TableInfo): GraphQLInputObjectType {
  const opInput = new GraphQLInputObjectType({
    name: `${table.name}_op`,
    fields: Object.fromEntries(WHERE_OPS.map(op => [op, { type: GraphQLString }])),
  });
  return new GraphQLInputObjectType({
    name: `${table.name}_where`,
    fields: () =>
      Object.fromEntries(
        table.columns.filter(c => GQL_NAME.test(c.name)).map(c => [c.name, { type: opInput }]),
      ),
  });
}

export interface BuildSchemaOptions {
  /** Tables the caller may not see at all. */
  exclude?: string[];
}

export function buildGraphQLSchema(
  snapshot: SchemaInfo,
  options: BuildSchemaOptions = {},
): GraphQLSchema {
  const exclude = new Set(options.exclude ?? []);
  const tables = snapshot.tables.filter(t => GQL_NAME.test(t.name) && !exclude.has(t.name));

  const query: GraphQLFieldConfigMap<unknown, GraphQLContext> = {};
  const mutation: GraphQLFieldConfigMap<unknown, GraphQLContext> = {};

  for (const table of tables) {
    const type = rowType(table);
    const where = whereInput(table);
    const setInput = inputType(table, `${table.name}_input`);

    query[table.name] = {
      type: new GraphQLList(type),
      description: `Rows from ${table.name}`,
      args: {
        where: { type: where },
        limit: { type: GraphQLInt },
        offset: { type: GraphQLInt },
        orderBy: { type: GraphQLString, description: 'e.g. "created_at.desc"' },
      },
      resolve: async (_src, args, ctx) => {
        const limit = Math.min(Number(args['limit'] ?? 20), ctx.maxLimit);
        const page = await ctx.engine.list(ctx.snapshot, table.name, {
          // Identity filters first; a query cannot displace them.
          filters: [
            ...ctx.filtersFor(table.name),
            ...whereToFilters(args['where'] as Record<string, unknown>),
          ],
          order: (args['orderBy'] as string) ?? null,
          limit,
          offset: Number(args['offset'] ?? 0),
          maxLimit: ctx.maxLimit,
        });
        return page.rows;
      },
    };

    if (table.primaryKeys.length === 1) {
      query[`${table.name}_by_pk`] = {
        type,
        args: { id: { type: new GraphQLNonNull(GraphQLID) } },
        resolve: async (_src, args, ctx) => {
          // Goes through list (not get) so the identity filters apply: get()
          // keys on the primary key alone and would return another owner's row.
          const page = await ctx.engine.list(ctx.snapshot, table.name, {
            filters: [
              ...ctx.filtersFor(table.name),
              `${table.primaryKeys[0]}=eq.${String(args['id'])}`,
            ],
            limit: 1,
            maxLimit: ctx.maxLimit,
          });
          return page.rows[0] ?? null;
        },
      };

      mutation[`insert_${table.name}`] = {
        type,
        args: { object: { type: new GraphQLNonNull(setInput) } },
        resolve: async (_src, args, ctx) => {
          requireWrite(ctx);
          return ctx.engine.create(
            ctx.snapshot,
            table.name,
            args['object'] as Record<string, unknown>,
          );
        },
      };

      mutation[`update_${table.name}_by_pk`] = {
        type,
        args: {
          id: { type: new GraphQLNonNull(GraphQLID) },
          set: { type: new GraphQLNonNull(setInput) },
        },
        resolve: async (_src, args, ctx) => {
          requireWrite(ctx);
          await assertVisible(ctx, table, String(args['id']));
          return ctx.engine.update(
            ctx.snapshot,
            table.name,
            String(args['id']),
            args['set'] as Record<string, unknown>,
          );
        },
      };

      mutation[`delete_${table.name}_by_pk`] = {
        type: GraphQLBoolean,
        args: { id: { type: new GraphQLNonNull(GraphQLID) } },
        resolve: async (_src, args, ctx) => {
          requireWrite(ctx);
          await assertVisible(ctx, table, String(args['id']));
          await ctx.engine.remove(ctx.snapshot, table.name, String(args['id']));
          return true;
        },
      };
    }
  }

  if (Object.keys(query).length === 0) {
    // A schema with no Query type is invalid; an empty database should say so
    // rather than throw an obscure construction error.
    query['_empty'] = {
      type: GraphQLString,
      resolve: () => 'This project has no tables yet.',
    };
  }

  return new GraphQLSchema({
    query: new GraphQLObjectType({ name: 'Query', fields: query }),
    ...(Object.keys(mutation).length > 0
      ? { mutation: new GraphQLObjectType({ name: 'Mutation', fields: mutation }) }
      : {}),
  });
}

function requireWrite(ctx: GraphQLContext): void {
  if (!ctx.canWrite) {
    throw new EngineError('FORBIDDEN', 'This key is read-only', 403);
  }
}

/**
 * Refuse a mutation on a row the caller cannot see.
 *
 * DataEngine.update/remove key on the primary key alone. Without this, a
 * non-admin customer could modify another owner's row by guessing its id —
 * the read path filters, so the write path must too.
 */
async function assertVisible(ctx: GraphQLContext, table: TableInfo, id: string): Promise<void> {
  const scope = ctx.filtersFor(table.name);
  if (scope.length === 0) return;
  const page = await ctx.engine.list(ctx.snapshot, table.name, {
    filters: [...scope, `${table.primaryKeys[0]}=eq.${id}`],
    limit: 1,
    maxLimit: ctx.maxLimit,
  });
  if (page.rows.length === 0) {
    throw new EngineError('ROW_NOT_FOUND', 'Row not found', 404);
  }
}

/** Largest document accepted, in characters. */
export const MAX_GRAPHQL_QUERY_BYTES = 16_384;

export interface GraphQLRunResult {
  data?: unknown;
  errors?: { message: string; path?: readonly (string | number)[] }[];
}

/**
 * Parse, validate and execute one operation.
 *
 * Validation uses graphql's standard rules, which reject unknown fields and
 * malformed documents before a resolver runs — so an unknown table cannot
 * reach the builder at all.
 */
export async function runGraphQL(
  schema: GraphQLSchema,
  input: {
    query: string;
    variables?: Record<string, unknown> | null;
    operationName?: string | null;
  },
  context: GraphQLContext,
): Promise<GraphQLRunResult> {
  if (typeof input.query !== 'string' || input.query.trim() === '') {
    return { errors: [{ message: 'A query is required' }] };
  }
  if (input.query.length > MAX_GRAPHQL_QUERY_BYTES) {
    return { errors: [{ message: 'Query document too large' }] };
  }

  let document: DocumentNode;
  try {
    document = parse(input.query);
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : 'Could not parse query' }] };
  }

  const errors = validate(schema, document, specifiedRules);
  if (errors.length > 0) {
    return { errors: errors.map(e => ({ message: e.message })) };
  }

  const result = await execute({
    schema,
    document,
    contextValue: context,
    variableValues: input.variables ?? undefined,
    operationName: input.operationName ?? undefined,
  });

  return {
    ...(result.data !== undefined ? { data: result.data } : {}),
    ...(result.errors
      ? {
          errors: result.errors.map(e => ({
            message: e.message,
            ...(e.path ? { path: e.path } : {}),
          })),
        }
      : {}),
  };
}
