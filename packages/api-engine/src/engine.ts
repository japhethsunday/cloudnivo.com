import type { SchemaInfo } from '@cloudnivo/database';
import {
  buildDelete,
  buildGet,
  buildInsert,
  buildList,
  buildUpdate,
  relationshipsOf,
  type ListOptions,
} from './query-builder.js';

/**
 * DataEngine — executes builder output against customer databases through an
 * injected `SqlExecutor`. Production passes the real parameterized executor
 * (`queryProjectDb`); tests pass an in-memory fake. The engine itself never
 * touches infra, so it works identically under Docker/Railway/VPS drivers.
 */

export type SqlExecutor = (text: string, params: unknown[]) => Promise<Record<string, unknown>[]>;

export interface Page {
  rows: Record<string, unknown>[];
  limit: number;
  offset: number;
}

export class DataEngine {
  constructor(private readonly exec: SqlExecutor) {}

  async list(snapshot: SchemaInfo, table: string, opts: ListOptions): Promise<Page> {
    const q = buildList(snapshot, table, opts);
    const rows = await this.exec(q.text, q.params);
    return { rows, limit: opts.limit ?? 20, offset: opts.offset ?? 0 };
  }

  async get(snapshot: SchemaInfo, table: string, id: string): Promise<Record<string, unknown>> {
    const q = buildGet(snapshot, table, id);
    const rows = await this.exec(q.text, q.params);
    const row = rows[0];
    if (!row) {
      const err = new Error('Row not found') as Error & { code: string; status: number };
      err.code = 'ROW_NOT_FOUND';
      err.status = 404;
      throw err;
    }
    return row;
  }

  async create(
    snapshot: SchemaInfo,
    table: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const q = buildInsert(snapshot, table, body);
    const rows = await this.exec(q.text, q.params);
    return rows[0] ?? {};
  }

  async update(
    snapshot: SchemaInfo,
    table: string,
    id: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    await this.get(snapshot, table, id);
    const q = buildUpdate(snapshot, table, id, body);
    const rows = await this.exec(q.text, q.params);
    return rows[0] ?? {};
  }

  async remove(snapshot: SchemaInfo, table: string, id: string): Promise<void> {
    await this.get(snapshot, table, id);
    const q = buildDelete(snapshot, table, id);
    await this.exec(q.text, q.params);
  }

  relationships(snapshot: SchemaInfo, table: string): { column: string; references: string }[] {
    return relationshipsOf(snapshot, table);
  }
}
