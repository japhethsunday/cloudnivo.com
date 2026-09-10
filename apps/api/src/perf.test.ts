import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { signSession } from '@cloudnivo/auth';
import { MemoryRegistry } from './registry.js';

const JWT_SECRET = 'p'.repeat(48);
const USER_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';

async function boot(): Promise<{ base: string; close: () => Promise<void> }> {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = 'postgres://u:p@localhost:5432/db';
  process.env.JWT_SECRET = JWT_SECRET;
  process.env.CORS_ORIGINS = 'http://localhost:3000';
  process.env.CACHE_DRIVER = 'memory';
  process.env.PROVISION_DRIVER = 'fake';
  const { start } = await import('./index.js');
  const { server, port } = await start(0);
  const srv = server as Server;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve, reject) => srv.close(e => (e ? reject(e) : resolve()))),
  };
}

/**
 * Performance regression tripwires (Phase 10 §35). Generous ceilings for
 * developer hardware — these catch order-of-magnitude regressions, not
 * noise. Real budgets live in tests/load/budgets.ts with measured results.
 */
describe('phase 10 performance tripwires (fake provider)', () => {
  let base = '';
  let close: () => Promise<void> = async () => {};
  let token = '';
  let projectId = '';

  beforeAll(async () => {
    const b = await boot();
    base = b.base;
    close = b.close;
    token = await signSession(
      { sub: USER_A, email: `${USER_A}@example.com` },
      { jwtSecret: JWT_SECRET },
    );
    const org = await (
      await fetch(`${base}/api/v1/organizations`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'perf', slug: 'perf' }),
      })
    ).json();
    const orgId = (org as { data: { organization: { id: string } } }).data.organization.id;
    const p = await (
      await fetch(`${base}/api/v1/projects`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'perf', slug: 'perf', organizationId: orgId }),
      })
    ).json();
    projectId = (p as { data: { project: { id: string } } }).data.project.id;
  });

  afterAll(async () => {
    await close();
  });

  it('signup + login complete within budget (scrypt cost bounded)', async () => {
    const start = Date.now();
    const email = `perf${Date.now() % 1000000}@example.com`;
    const s = await fetch(`${base}/api/v1/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'long-enough-1' }),
    });
    expect(s.status).toBe(201);
    const l = await fetch(`${base}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'long-enough-1' }),
    });
    expect(l.status).toBe(200);
    expect(Date.now() - start).toBeLessThan(8000);
  });

  it('AI plan + project list + data read complete within budget', async () => {
    let start = Date.now();
    const plan = await fetch(`${base}/api/v1/projects/${projectId}/ai/plan`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'I need tasks with priorities for tracking.' }),
    });
    expect(plan.status).toBe(201);
    expect(Date.now() - start).toBeLessThan(3000);

    start = Date.now();
    const list = await fetch(`${base}/api/v1/projects`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(list.status).toBe(200);
    expect(Date.now() - start).toBeLessThan(2000);

    start = Date.now();
    const read = await fetch(`${base}/api/v1/projects/${projectId}/users`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(read.status).toBe(200);
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it('batched registry reads return matching db+credential pairs', async () => {
    const registry = new MemoryRegistry();
    const { org } = await registry.createOrganization(USER_A, 'Batch', 'batch');
    const project = await registry.createProject({
      userId: USER_A,
      organizationId: org.id,
      name: 'Batch',
      slug: 'batch',
      region: 'local',
    });
    await registry.saveDatabase({
      projectId: project.id,
      organizationId: org.id,
      databaseId: 'db_batch',
      host: '127.0.0.1',
      port: 5432,
      dbName: 'b',
      dbUser: 'u',
      version: '16',
      region: 'local',
      status: 'ready',
    });
    await registry.saveCredential(project.id, 'u', 'pw');
    const rows = await registry.listProjectDatabases([
      project.id,
      '00000000-0000-4000-8000-000000000000',
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.db?.databaseId).toBe('db_batch');
    expect(rows[0]?.cred?.dbUser).toBe('u');
    expect(rows[1]?.db).toBe(null);
    expect(rows[1]?.cred).toBe(null);
  });
});
