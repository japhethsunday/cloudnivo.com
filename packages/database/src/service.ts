import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { existsSync } from 'node:fs';
import postgres from 'postgres';
import * as schema from './schema.js';

/**
 * DatabaseService abstraction — the ONLY way app code touches PostgreSQL.
 * The Drizzle instance is an implementation detail; callers use typed helpers
 * and tenant-scoped queries. Swapping to a managed/cloud Postgres later means
 * replacing `createDatabaseService`, not call sites.
 */

export type Database = PostgresJsDatabase<typeof schema>;

export interface HealthResult {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

export interface DatabaseService {
  readonly db: Database;
  /** Fail-safe liveness probe. Never throws — returns `{ ok: false }` instead. */
  healthCheck(): Promise<HealthResult>;
  /** Close the underlying pool (tests / graceful shutdown). */
  close(): Promise<void>;
}

export function parseDatabaseUrl(url: string): { host: string; database: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('DATABASE_URL is not a valid URL');
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error('DATABASE_URL must use postgres://');
  }
  return { host: parsed.hostname, database: parsed.pathname.replace(/^\//, '') };
}

export function createDatabaseService(connectionString: string): DatabaseService {
  // Validated eagerly so boot fails fast with a clear message (no credential echo).
  parseDatabaseUrl(connectionString);
  const client = postgres(connectionString, { max: 10, idle_timeout: 20 });
  const db = drizzle(client, { schema });

  return {
    db,
    async healthCheck(): Promise<HealthResult> {
      const start = Date.now();
      try {
        await client`select 1`;
        return { ok: true, latencyMs: Date.now() - start };
      } catch (err) {
        return {
          ok: false,
          latencyMs: Date.now() - start,
          error: err instanceof Error ? err.message : 'unknown database error',
        };
      }
    },
    async close(): Promise<void> {
      await client.end({ timeout: 5 });
    },
  };
}

/**
 * Apply pending control-plane migrations (drizzle journal, ordered).
 * Used by `MIGRATE_ON_BOOT=true` deploys and one-off release commands —
 * never implicitly. Throws with a credential-free message on failure so
 * boot halts instead of serving against a stale schema.
 */
export async function runControlMigrations(
  connectionString: string,
  migrationsFolder: string,
): Promise<void> {
  parseDatabaseUrl(connectionString);
  if (!existsSync(migrationsFolder)) {
    throw new Error(`Migrations folder not found: ${migrationsFolder}`);
  }
  const client = postgres(connectionString, { max: 1 });
  try {
    const db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Control-plane migration failed: ${msg.slice(0, 300)}`);
  } finally {
    await client.end({ timeout: 5 }).catch(() => undefined);
  }
}
