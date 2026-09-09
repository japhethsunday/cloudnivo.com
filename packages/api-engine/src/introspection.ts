import type { SchemaInfo, TableInfo } from '@cloudnivo/database';

/**
 * DatabaseIntrospectionService — schema discovery behind a cache.
 *
 * The snapshot ALWAYS comes from live `information_schema` reads; the cache
 * only bounds cost (TTL, default 30s). Writes through the API engine
 * invalidate the entry, so DDL is picked up without waiting out the TTL.
 */

export interface IntrospectionSource {
  read(): Promise<SchemaInfo>;
}

export interface IntrospectionService {
  getSchema(): Promise<SchemaInfo>;
  getTables(): Promise<TableInfo[]>;
  getColumns(table: string): Promise<TableInfo['columns']>;
  getPrimaryKeys(table: string): Promise<string[]>;
  getForeignKeys(): Promise<SchemaInfo['foreignKeys']>;
  getIndexes(table: string): Promise<TableInfo['indexes']>;
  invalidate(): void;
}

function findTable(snapshot: SchemaInfo, table: string): TableInfo {
  const t = snapshot.tables.find(x => x.name === table);
  if (!t) {
    const err = new Error(`Table not found: ${table}`) as Error & { code: string; status: number };
    err.code = 'TABLE_NOT_FOUND';
    err.status = 404;
    throw err;
  }
  return t;
}

export class CachingIntrospectionService implements IntrospectionService {
  private cached: { at: number; schema: SchemaInfo } | null = null;

  constructor(
    private readonly source: IntrospectionSource,
    private readonly ttlMs: number = 30_000,
  ) {}

  async getSchema(): Promise<SchemaInfo> {
    const now = Date.now();
    if (this.cached && now - this.cached.at < this.ttlMs) return this.cached.schema;
    const schema = await this.source.read();
    this.cached = { at: now, schema };
    return schema;
  }

  async getTables(): Promise<TableInfo[]> {
    return (await this.getSchema()).tables;
  }

  async getColumns(table: string): Promise<TableInfo['columns']> {
    return findTable(await this.getSchema(), table).columns;
  }

  async getPrimaryKeys(table: string): Promise<string[]> {
    return findTable(await this.getSchema(), table).primaryKeys;
  }

  async getForeignKeys(): Promise<SchemaInfo['foreignKeys']> {
    return (await this.getSchema()).foreignKeys;
  }

  async getIndexes(table: string): Promise<TableInfo['indexes']> {
    return findTable(await this.getSchema(), table).indexes;
  }

  invalidate(): void {
    this.cached = null;
  }
}
