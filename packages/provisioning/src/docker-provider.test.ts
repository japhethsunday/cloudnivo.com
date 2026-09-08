import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { DockerDatabaseProvider } from './docker-provider.js';

const execFileAsync = promisify(execFile);

async function dockerPresent(): Promise<boolean> {
  try {
    await execFileAsync('docker', ['version', '--format', '{{.Server.Version}}'], {
      timeout: 10_000,
    });
    return true;
  } catch {
    return false;
  }
}

// Real end-to-end against local Docker Postgres. Runs only with
// DOCKER_TESTS=1 on a machine with Docker (CI/dev). Skipped otherwise —
// unit coverage comes from engine.test.ts with the fake provider.
const runDocker = process.env.DOCKER_TESTS === '1';
describe.skipIf(!runDocker)('docker provider (integration)', () => {
  it('provisions → status → metrics → delete for real', async () => {
    if (!(await dockerPresent())) {
      console.warn('Docker not present; skipping live assertions');
      return;
    }
    const provider = new DockerDatabaseProvider({ basePort: 15500, healthTimeoutMs: 120_000 });
    const created = await provider.createDatabase({
      projectId: 'itest-project',
      organizationId: 'itest-org',
      slug: 'itest-shop',
      password: 'integration-test-pw-1',
      version: '16',
      region: 'local',
    });
    expect(created.host).toBe('127.0.0.1');
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
      await provider.stopDatabase(created.databaseId);
      const stopped = await provider.getStatus(created.databaseId, conn);
      expect(stopped.status).toBe('stopped');
      await provider.startDatabase(created.databaseId);
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
