import type { StatsQuery } from './advisors.js';
import { DbToolsError } from './errors.js';

/**
 * Read-only catalog introspection: functions, triggers, views, sequences,
 * extensions, and replication stats. All queries are fixed text (no
 * interpolation) and bounded — safe to expose through the database API.
 */

export interface DbFunction {
  schema: string;
  name: string;
  args: string;
  returns: string;
  language: string;
  security: 'invoker' | 'definer';
}

export interface DbTrigger {
  schema: string;
  table: string;
  name: string;
  timing: string;
  events: string;
  function: string;
}

export interface DbView {
  schema: string;
  name: string;
  definition: string;
}

export interface DbExtension {
  name: string;
  version: string;
  schema: string;
}

/** Extensions users may self-install (curated: no privileged/system ones). */
export const EXTENSION_ALLOWLIST = new Set([
  'pgcrypto',
  'uuid-ossp',
  'citext',
  'pg_trgm',
  'unaccent',
  'btree_gin',
  'btree_gist',
  'pg_stat_statements',
  'tablefunc',
  'fuzzystrmatch',
  'ltree',
  'hstore',
  // Vector similarity search. Ships the `vector` type plus the hnsw/ivfflat
  // index access methods; no privileged hooks, so it is safe to self-install.
  'vector',
]);

export function assertExtensionAllowed(name: string): string {
  const clean = name.trim().toLowerCase();
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(clean)) {
    throw new DbToolsError('VALIDATION_ERROR', `Invalid extension name: ${name.slice(0, 60)}`, 400);
  }
  if (!EXTENSION_ALLOWLIST.has(clean)) {
    throw new DbToolsError(
      'VALIDATION_ERROR',
      `Extension not allowlisted: ${clean} (request review to add it)`,
      400,
    );
  }
  return clean;
}

export async function listFunctions(run: StatsQuery): Promise<DbFunction[]> {
  const rows = await run(
    `select n.nspname as schema, p.proname as name,
            pg_get_function_arguments(p.oid) as args,
            pg_get_function_result(p.oid) as returns,
            l.lanname as language,
            case when p.prosecdef then 'definer' else 'invoker' end as security
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     join pg_language l on l.oid = p.prolang
     where n.nspname not in ('pg_catalog', 'information_schema')
     order by 1, 2`,
    [],
  );
  return rows.slice(0, 500).map(r => ({
    schema: String(r['schema'] ?? ''),
    name: String(r['name'] ?? ''),
    args: String(r['args'] ?? ''),
    returns: String(r['returns'] ?? ''),
    language: String(r['language'] ?? ''),
    security: r['security'] === 'definer' ? 'definer' : 'invoker',
  }));
}

export async function listTriggers(run: StatsQuery): Promise<DbTrigger[]> {
  const rows = await run(
    `select event_object_schema as schema, event_object_table as tbl,
            trigger_name as name, action_timing as timing,
            string_agg(event_manipulation, ',' order by event_manipulation) as events,
            action_statement as func
     from information_schema.triggers
     where trigger_schema not in ('pg_catalog', 'information_schema')
     group by 1, 2, 3, 4, 6 order by 1, 2, 3`,
    [],
  );
  return rows.slice(0, 500).map(r => ({
    schema: String(r['schema'] ?? ''),
    table: String(r['tbl'] ?? ''),
    name: String(r['name'] ?? ''),
    timing: String(r['timing'] ?? ''),
    events: String(r['events'] ?? ''),
    function: String(r['func'] ?? ''),
  }));
}

export async function listViews(run: StatsQuery): Promise<DbView[]> {
  const rows = await run(
    `select schemaname as schema, viewname as name, definition
     from pg_views where schemaname not in ('pg_catalog', 'information_schema')
     order by 1, 2`,
    [],
  );
  return rows.slice(0, 200).map(r => ({
    schema: String(r['schema'] ?? ''),
    name: String(r['name'] ?? ''),
    definition: String(r['definition'] ?? '').slice(0, 8000),
  }));
}

export async function listExtensions(run: StatsQuery): Promise<DbExtension[]> {
  const rows = await run(
    `select e.extname as name, e.extversion as version, n.nspname as schema
     from pg_extension e join pg_namespace n on n.oid = e.extnamespace
     order by 1`,
    [],
  );
  return rows.map(r => ({
    name: String(r['name'] ?? ''),
    version: String(r['version'] ?? ''),
    schema: String(r['schema'] ?? ''),
  }));
}
