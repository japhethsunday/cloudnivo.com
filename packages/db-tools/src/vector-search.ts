import { DbToolsError } from './errors.js';

/**
 * Vector, keyword and hybrid search planning — the pure half.
 *
 * Every value a caller supplies becomes a bound parameter; every identifier
 * is validated against a strict pattern and quoted. Nothing a caller sends
 * is ever concatenated into SQL, because this runs against tenant databases
 * where a single injection is a cross-customer data breach.
 *
 * Ranking modes:
 *  - `semantic`: nearest neighbour on a pgvector column.
 *  - `keyword`: full-text rank over one or more text columns.
 *  - `hybrid`:  both, fused with Reciprocal Rank Fusion. RRF is used rather
 *    than a weighted score sum because distance and ts_rank live on
 *    incomparable scales — normalising them needs corpus statistics the
 *    planner does not have, while RRF only needs each side's ordering.
 *
 * The API layer owns connections, authorization and row filtering; this file
 * owns SQL construction, so it is testable without a Postgres.
 */

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

/** Distance operators pgvector exposes, by the metric the index was built for. */
const METRIC_OPERATOR = {
  cosine: '<=>',
  l2: '<->',
  inner_product: '<#>',
} as const;

export type VectorMetric = keyof typeof METRIC_OPERATOR;
export type SearchMode = 'semantic' | 'keyword' | 'hybrid';

/** Index types pgvector supports, with the operator class per metric. */
const OPCLASS = {
  cosine: 'vector_cosine_ops',
  l2: 'vector_l2_ops',
  inner_product: 'vector_ip_ops',
} as const;

export const MAX_SEARCH_LIMIT = 200;
export const DEFAULT_SEARCH_LIMIT = 20;
/** Guards against a caller pinning memory with an enormous embedding. */
export const MAX_VECTOR_DIMENSIONS = 4096;

export interface VectorSearchRequest {
  table: string;
  mode: SearchMode;
  /** Embedding to search by. Required for semantic and hybrid. */
  vector?: number[];
  /** pgvector column. Required for semantic and hybrid. */
  vectorColumn?: string;
  metric?: VectorMetric;
  /** Query text. Required for keyword and hybrid. */
  query?: string;
  /** Text columns to rank on. Required for keyword and hybrid. */
  textColumns?: string[];
  /** Text search configuration, e.g. 'english'. */
  textConfig?: string;
  /** Columns to return. Empty/omitted returns the whole row. */
  select?: string[];
  limit?: number;
  /**
   * A fully-formed SQL predicate the API layer built itself (row ownership,
   * RLS scoping). Never caller-supplied — see assertTrustedFilter.
   */
  filterSql?: string;
  filterParams?: unknown[];
}

export interface SearchPlan {
  text: string;
  params: unknown[];
  mode: SearchMode;
  limit: number;
}

function ident(value: unknown, what: string): string {
  if (typeof value !== 'string' || !IDENT_RE.test(value)) {
    throw new DbToolsError(
      'VALIDATION_ERROR',
      `Invalid ${what}: ${String(value).slice(0, 60)}`,
      400,
    );
  }
  return `"${value}"`;
}

function boundedLimit(limit: unknown): number {
  if (limit === undefined || limit === null) return DEFAULT_SEARCH_LIMIT;
  const n = Number(limit);
  if (!Number.isInteger(n) || n < 1) {
    throw new DbToolsError('VALIDATION_ERROR', 'limit must be a positive integer', 400);
  }
  return Math.min(n, MAX_SEARCH_LIMIT);
}

/**
 * pgvector's literal form is `[1,2,3]`. Built here from numbers that have
 * already been proven finite, then bound as ONE parameter — never spliced
 * into the statement.
 */
export function toVectorLiteral(vector: unknown): string {
  if (!Array.isArray(vector) || vector.length === 0) {
    throw new DbToolsError('VALIDATION_ERROR', 'vector must be a non-empty array of numbers', 400);
  }
  if (vector.length > MAX_VECTOR_DIMENSIONS) {
    throw new DbToolsError(
      'VALIDATION_ERROR',
      `vector exceeds ${MAX_VECTOR_DIMENSIONS} dimensions`,
      400,
    );
  }
  const parts = vector.map(v => {
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n)) {
      throw new DbToolsError('VALIDATION_ERROR', 'vector must contain only finite numbers', 400);
    }
    return String(n);
  });
  return `[${parts.join(',')}]`;
}

function metricOf(metric: unknown): VectorMetric {
  if (metric === undefined || metric === null) return 'cosine';
  if (typeof metric !== 'string' || !(metric in METRIC_OPERATOR)) {
    throw new DbToolsError(
      'VALIDATION_ERROR',
      `Unknown metric: ${String(metric).slice(0, 40)} (cosine, l2, inner_product)`,
      400,
    );
  }
  return metric as VectorMetric;
}

/**
 * Text search configurations are an identifier position in `to_tsvector`, so
 * this is an allowlist rather than a pattern: a caller must not be able to
 * name an arbitrary object here.
 */
const TEXT_CONFIGS = new Set([
  'simple',
  'english',
  'french',
  'german',
  'spanish',
  'portuguese',
  'italian',
  'dutch',
  'russian',
  'swedish',
  'norwegian',
  'danish',
  'finnish',
  'turkish',
]);

function textConfigOf(config: unknown): string {
  if (config === undefined || config === null) return 'english';
  const clean = String(config).trim().toLowerCase();
  if (!TEXT_CONFIGS.has(clean)) {
    throw new DbToolsError(
      'VALIDATION_ERROR',
      `Unsupported text search configuration: ${clean.slice(0, 40)}`,
      400,
    );
  }
  return clean;
}

function selectList(select: unknown): string {
  if (select === undefined || select === null) return '*';
  if (!Array.isArray(select) || select.length === 0) return '*';
  return select.map(c => ident(c, 'select column')).join(', ');
}

/**
 * The filter predicate is built by the API layer from the caller's identity,
 * never from request input. This refuses anything carrying a statement
 * terminator or comment introducer, so a future call site that wired caller
 * input into it fails loudly here instead of silently widening access.
 */
function assertTrustedFilter(filterSql: string): void {
  if (/;|--|\/\*/.test(filterSql)) {
    throw new DbToolsError('VALIDATION_ERROR', 'Unsafe filter predicate', 400);
  }
}

/**
 * Build the search statement.
 *
 * Params are numbered in the order they are pushed, so callers must bind the
 * returned `params` positionally as given.
 */
export function planSearch(req: VectorSearchRequest): SearchPlan {
  const mode = req.mode;
  if (mode !== 'semantic' && mode !== 'keyword' && mode !== 'hybrid') {
    throw new DbToolsError(
      'VALIDATION_ERROR',
      `Unknown search mode: ${String(mode).slice(0, 40)} (semantic, keyword, hybrid)`,
      400,
    );
  }

  const table = ident(req.table, 'table');
  const cols = selectList(req.select);
  const limit = boundedLimit(req.limit);
  const params: unknown[] = [];

  let where = '';
  if (req.filterSql) {
    assertTrustedFilter(req.filterSql);
    for (const p of req.filterParams ?? []) params.push(p);
    where = ` WHERE ${req.filterSql}`;
  }

  if (mode === 'semantic') {
    const vcol = ident(req.vectorColumn, 'vectorColumn');
    const op = METRIC_OPERATOR[metricOf(req.metric)];
    params.push(toVectorLiteral(req.vector));
    const vec = `$${params.length}::vector`;
    params.push(limit);
    const lim = `$${params.length}`;
    return {
      text:
        `SELECT ${cols}, ${vcol} ${op} ${vec} AS distance FROM ${table}${where} ` +
        `ORDER BY ${vcol} ${op} ${vec} LIMIT ${lim}`,
      params,
      mode,
      limit,
    };
  }

  if (mode === 'keyword') {
    const doc = documentExpression(req.textColumns);
    const cfg = textConfigOf(req.textConfig);
    params.push(requireQuery(req.query));
    const q = `$${params.length}`;
    params.push(limit);
    const lim = `$${params.length}`;
    const tsv = `to_tsvector('${cfg}', ${doc})`;
    const tsq = `websearch_to_tsquery('${cfg}', ${q})`;
    return {
      text:
        `SELECT ${cols}, ts_rank(${tsv}, ${tsq}) AS rank FROM ${table}` +
        `${where ? `${where} AND` : ' WHERE'} ${tsv} @@ ${tsq} ` +
        `ORDER BY ts_rank(${tsv}, ${tsq}) DESC LIMIT ${lim}`,
      params,
      mode,
      limit,
    };
  }

  return planHybrid(req, { table, cols, limit, params, where });
}

function requireQuery(query: unknown): string {
  if (typeof query !== 'string' || query.trim() === '') {
    throw new DbToolsError('VALIDATION_ERROR', 'query is required for keyword search', 400);
  }
  return query;
}

function documentExpression(textColumns: unknown): string {
  if (!Array.isArray(textColumns) || textColumns.length === 0) {
    throw new DbToolsError(
      'VALIDATION_ERROR',
      'textColumns is required for keyword and hybrid search',
      400,
    );
  }
  // coalesce so a NULL column does not null the whole document.
  return textColumns.map(c => `coalesce(${ident(c, 'text column')}, '')`).join(" || ' ' || ");
}

/** RRF's rank constant. 60 is the value from the original Cormack paper. */
export const RRF_K = 60;

function planHybrid(
  req: VectorSearchRequest,
  ctx: { table: string; cols: string; limit: number; params: unknown[]; where: string },
): SearchPlan {
  const { table, cols, limit, params, where } = ctx;
  const vcol = ident(req.vectorColumn, 'vectorColumn');
  const op = METRIC_OPERATOR[metricOf(req.metric)];
  const cfg = textConfigOf(req.textConfig);
  const doc = documentExpression(req.textColumns);

  params.push(toVectorLiteral(req.vector));
  const vec = `$${params.length}::vector`;
  params.push(requireQuery(req.query));
  const q = `$${params.length}`;
  params.push(limit);
  const lim = `$${params.length}`;

  const tsv = `to_tsvector('${cfg}', ${doc})`;
  const tsq = `websearch_to_tsquery('${cfg}', ${q})`;
  // Each side is over-fetched before fusion: a row ranked just outside the
  // limit on one side can still rank high after fusion.
  const pool = `LEAST(${lim} * 4, ${MAX_SEARCH_LIMIT * 4})`;

  return {
    text:
      `WITH semantic AS (` +
      `SELECT ctid, row_number() OVER (ORDER BY ${vcol} ${op} ${vec}) AS pos ` +
      `FROM ${table}${where} ORDER BY ${vcol} ${op} ${vec} LIMIT ${pool}` +
      `), keyword AS (` +
      `SELECT ctid, row_number() OVER (ORDER BY ts_rank(${tsv}, ${tsq}) DESC) AS pos ` +
      `FROM ${table}${where ? `${where} AND` : ' WHERE'} ${tsv} @@ ${tsq} ` +
      `ORDER BY ts_rank(${tsv}, ${tsq}) DESC LIMIT ${pool}` +
      `), fused AS (` +
      `SELECT coalesce(s.ctid, k.ctid) AS ctid, ` +
      `coalesce(1.0 / (${RRF_K} + s.pos), 0) + coalesce(1.0 / (${RRF_K} + k.pos), 0) AS score ` +
      `FROM semantic s FULL OUTER JOIN keyword k ON s.ctid = k.ctid` +
      `) SELECT ${cols === '*' ? 't.*' : cols}, f.score AS score ` +
      `FROM fused f JOIN ${table} t ON t.ctid = f.ctid ` +
      `ORDER BY f.score DESC LIMIT ${lim}`,
    params,
    mode: 'hybrid',
    limit,
  };
}

export type VectorIndexType = 'hnsw' | 'ivfflat';

/**
 * DDL for a vector index. Separate from search because creating one is a
 * migration: it belongs in the approval path, not in a query.
 */
export function planVectorIndex(args: {
  table: string;
  column: string;
  metric?: VectorMetric;
  type?: VectorIndexType;
  /** ivfflat only. Postgres default is 100. */
  lists?: number;
}): string {
  const table = ident(args.table, 'table');
  const column = ident(args.column, 'column');
  const metric = metricOf(args.metric);
  const type = args.type ?? 'hnsw';
  if (type !== 'hnsw' && type !== 'ivfflat') {
    throw new DbToolsError('VALIDATION_ERROR', `Unknown index type: ${String(type)}`, 400);
  }
  const name = ident(`idx_${args.table}_${args.column}_${type}`.slice(0, 63), 'index name');
  const opclass = OPCLASS[metric];

  if (type === 'ivfflat') {
    const lists = args.lists ?? 100;
    if (!Number.isInteger(lists) || lists < 1 || lists > 32_768) {
      throw new DbToolsError('VALIDATION_ERROR', 'lists must be between 1 and 32768', 400);
    }
    return `CREATE INDEX ${name} ON ${table} USING ivfflat (${column} ${opclass}) WITH (lists = ${lists});`;
  }
  return `CREATE INDEX ${name} ON ${table} USING hnsw (${column} ${opclass});`;
}
