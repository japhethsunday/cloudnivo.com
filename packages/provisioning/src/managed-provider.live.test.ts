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
        // ...but NOT the control database.
        await expect(
          sql`select 1 from pg_database where datname = 'postgres'`.simple(),
        ).rejects.toThrow();
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
