import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { ManagedPostgresProvider } from './managed-provider.js';

// Full lifecycle against a real PostgreSQL server. Runs only with
// LIVE_PG_URL=postgres://<admin>:<pw>@<host>/<db> set (the server acts as
// the "shared managed host"). Skipped otherwise.
const LIVE_PG_URL = process.env.LIVE_PG_URL ?? '';
describe.skipIf(!LIVE_PG_URL)('managed provider on live postgres', () => {
  it('provisions → isolates → stops/starts → deletes for real', async () => {
    const provider = new ManagedPostgresProvider({ connectionString: LIVE_PG_URL });
    expect(await provider.isAvailable()).toBe(true);
    const created = await provider.createDatabase({
      projectId: 'itest-project',
      organizationId: 'itest-org',
      slug: 'itest-shop',
      password: 'integration-test-pw-1',
      version: '16',
      region: 'local',
    });
    expect(created.databaseId).toMatch(/^managed:[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$/);
    // Idempotent re-create adopts the existing database.
    const again = await provider.createDatabase({
      projectId: 'itest-project',
      organizationId: 'itest-org',
      slug: 'itest-shop',
      password: 'integration-test-pw-1',
      version: '16',
      region: 'local',
    });
    expect(again.databaseId).toBe(created.databaseId);
    try {
      const conn = {
        host: created.host,
        port: created.port,
        database: created.dbName,
        user: created.dbUser,
        password: 'integration-test-pw-1',
      };
      const status = await provider.getStatus(created.databaseId, conn);
      expect(status.status).toBe('running');
      expect(status.health).toBe('healthy');
      const metrics = await provider.getMetrics(conn);
      expect(metrics.sizeBytes).toBeGreaterThan(0);
      // Project role reaches its own database...
      const sql = postgres(
        `postgres://${created.dbUser}:integration-test-pw-1@${created.host}:${created.port}/${created.dbName}`,
        { max: 1 },
      );
      try {
        await sql.unsafe('create table iso_probe (id serial primary key, v text)');
        await sql.unsafe(`insert into iso_probe (v) values ('ok')`);
        const rows = (await sql.unsafe('select v from iso_probe')) as { v: string }[];
        expect(rows[0]?.v).toBe('ok');
        // This query used to stand in for "cannot reach the control database".
        // It never did: it reads a SHARED CATALOG from inside the project's own
        // database, which Postgres allows to PUBLIC, so it passed even while
        // any project role could actually open the control database. Catalog
        // visibility is a known, documented exposure (SECURITY-AUDIT.md #10);
        // the real connection boundary is asserted in the suite below.
        const catalog = (await sql`select datname from pg_database where datname = current_database()`.simple()) as {
          datname: string;
        }[];
        expect(catalog[0]?.datname).toBe(created.dbName);
      } finally {
        await sql.end({ timeout: 2 }).catch(() => undefined);
      }
      await provider.stopDatabase(created.databaseId);
      const stopped = await provider.getStatus(created.databaseId, conn);
      expect(stopped.status).toBe('stopped');
      await provider.startDatabase(created.databaseId);
      const restarted = await provider.getStatus(created.databaseId, conn);
      expect(restarted.status).toBe('running');
    } finally {
      await provider.deleteDatabase(created.databaseId);
      const after = await provider.getStatus(created.databaseId, {
        host: created.host,
        port: created.port,
        database: created.dbName,
        user: created.dbUser,
        password: 'integration-test-pw-1',
      });
      expect(after.status).toBe('deleted');
    }
  }, 300_000);
});

/**
 * Cross-tenant connection boundary, against a real cluster.
 *
 * Postgres grants CONNECT on a new database to PUBLIC, and a privilege held
 * through PUBLIC is not removed by revoking it from a role — so the original
 * `REVOKE ALL ... FROM "<project role>"` was a no-op and every project role
 * could open every other project's database and the control database.
 */
describe.skipIf(!LIVE_PG_URL)('managed provider tenant isolation', () => {
  it('keeps one project role out of another project database and the control database', async () => {
    const provider = new ManagedPostgresProvider({ connectionString: LIVE_PG_URL });
    const stamp = Date.now().toString(36);
    const pwA = `isolation-test-a-${stamp}`;
    const pwB = `isolation-test-b-${stamp}`;
    const a = await provider.createDatabase({
      projectId: 'iso-a',
      organizationId: 'iso',
      slug: `isoa${stamp}`,
      password: pwA,
      version: '16',
      region: 'local',
    });
    const b = await provider.createDatabase({
      projectId: 'iso-b',
      organizationId: 'iso',
      slug: `isob${stamp}`,
      password: pwB,
      version: '16',
      region: 'local',
    });
    const controlDb = new URL(LIVE_PG_URL).pathname.replace(/^\//, '') || 'postgres';
    const connectAs = async (user: string, password: string, database: string): Promise<string> => {
      const url = new URL(LIVE_PG_URL);
      url.username = user;
      url.password = password;
      url.pathname = `/${database}`;
      const sql = postgres(url.toString(), { max: 1, idle_timeout: 2, connect_timeout: 5 });
      try {
        await sql`select 1`;
        return 'connected';
      } catch (err) {
        return err instanceof Error ? err.message : 'failed';
      } finally {
        await sql.end({ timeout: 2 }).catch(() => undefined);
      }
    };
    try {
      // Its own database stays reachable — isolation must not break the product.
      expect(await connectAs(a.dbUser, pwA, a.dbName)).toBe('connected');
      expect(await connectAs(b.dbUser, pwB, b.dbName)).toBe('connected');
      // The neighbour's database and the control database must not be.
      expect(await connectAs(a.dbUser, pwA, b.dbName)).toMatch(/permission denied/i);
      expect(await connectAs(b.dbUser, pwB, a.dbName)).toMatch(/permission denied/i);
      expect(await connectAs(a.dbUser, pwA, controlDb)).toMatch(/permission denied/i);
    } finally {
      await provider.deleteDatabase(a.databaseId).catch(() => undefined);
      await provider.deleteDatabase(b.databaseId).catch(() => undefined);
    }
  }, 60_000);
});
