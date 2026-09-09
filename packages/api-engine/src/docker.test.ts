import { describe, expect, it } from 'vitest';
import { inspectProjectSchema, queryProjectDb } from '@cloudnivo/database';
import { CachingIntrospectionService, DataEngine } from '@cloudnivo/api-engine';
import { DockerDatabaseProvider } from '@cloudnivo/provisioning';

// Full E2E against REAL PostgreSQL in a REAL container:
// provision → DDL → introspect → CRUD → delete. Runs only with
// DOCKER_TESTS=1 on a Docker machine. Skipped otherwise.
const runDocker = process.env.DOCKER_TESTS === '1';
describe.skipIf(!runDocker)('api engine on real postgres', () => {
  it('discovers tables and serves CRUD for real', async () => {
    const provider = new DockerDatabaseProvider({ basePort: 15600, healthTimeoutMs: 120_000 });
    const created = await provider.createDatabase({
      projectId: 'engine-itest',
      organizationId: 'engine-itest-org',
      slug: 'engine-shop',
      password: 'engine-integration-1',
      version: '16',
      region: 'local',
    });
    const conn = {
      host: created.host,
      port: created.port,
      database: created.dbName,
      user: created.dbUser,
      password: 'engine-integration-1',
    };
    try {
      await queryProjectDb(
        conn,
        'CREATE TABLE widgets (id uuid PRIMARY KEY, name text NOT NULL)',
        [],
      );
      const svc = new CachingIntrospectionService({ read: () => inspectProjectSchema(conn) });
      const schema = await svc.getSchema();
      expect(schema.tables.map(t => t.name)).toContain('widgets');

      const engine = new DataEngine((text, params) => queryProjectDb(conn, text, params));
      const made = await engine.create(schema, 'widgets', {
        id: '11111111-1111-4111-8111-111111111111',
        name: 'gizmo',
      });
      expect(made['name']).toBe('gizmo');
      const page = await engine.list(schema, 'widgets', { filters: ['name=eq.gizmo'] });
      expect(page.rows).toHaveLength(1);
      const one = await engine.get(schema, 'widgets', '11111111-1111-4111-8111-111111111111');
      expect(one['name']).toBe('gizmo');
      await engine.update(schema, 'widgets', '11111111-1111-4111-8111-111111111111', {
        name: 'gadget',
      });
      expect(
        (await engine.get(schema, 'widgets', '11111111-1111-4111-8111-111111111111'))['name'],
      ).toBe('gadget');
      await engine.remove(schema, 'widgets', '11111111-1111-4111-8111-111111111111');
      expect((await engine.list(schema, 'widgets', {})).rows).toHaveLength(0);
    } finally {
      await provider.deleteDatabase(created.databaseId);
    }
  }, 300_000);
});
