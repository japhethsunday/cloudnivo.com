import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { signSession } from '@cloudnivo/auth';

const JWT_SECRET = 'u'.repeat(48);
const USER_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const USER_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

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

async function tokenFor(sub: string): Promise<string> {
  return signSession({ sub, email: `${sub}@example.com` }, { jwtSecret: JWT_SECRET });
}

async function api(
  base: string,
  method: string,
  path: string,
  token: string | null,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

function data<T>(json: Record<string, unknown>): T {
  return (json['data'] ?? json) as T;
}

async function pollJob(
  base: string,
  token: string,
  projectId: string,
  jobId: string,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const r = await api(base, 'GET', `/api/v1/projects/${projectId}/jobs/${jobId}`, token);
    expect(r.status).toBe(200);
    const job = data<{ job: Record<string, unknown> }>(r.json).job;
    if (job['status'] === 'completed' || job['status'] === 'failed') return job;
    if (Date.now() > deadline) throw new Error('job did not settle in time');
    await new Promise(r2 => setTimeout(r2, 50));
  }
}

describe('phase 2 provisioning API (fake provider)', () => {
  let base = '';
  let close: () => Promise<void> = async () => {};
  let tokenA = '';
  let tokenB = '';
  let orgA = '';
  let projectId = '';

  beforeAll(async () => {
    const b = await boot();
    base = b.base;
    close = b.close;
    tokenA = await tokenFor(USER_A);
    tokenB = await tokenFor(USER_B);
    const org = await api(base, 'POST', '/api/v1/organizations', tokenA, {
      name: 'Org A',
      slug: 'org-a',
    });
    expect(org.status).toBe(201);
    orgA = data<{ organization: { id: string } }>(org.json).organization.id;
  });
  afterAll(async () => {
    await close();
  });

  it('creates orgs per user (tenant roots)', async () => {
    const r = await api(base, 'GET', '/api/v1/organizations', tokenA);
    expect(r.status).toBe(200);
    expect(data<{ organizations: unknown[] }>(r.json).organizations).toHaveLength(1);
  });

  it('provisions a project database end-to-end (202 → completed → ready)', async () => {
    const created = await api(base, 'POST', '/api/v1/projects', tokenA, {
      name: 'Shop',
      slug: 'shop',
      organizationId: orgA,
    });
    expect(created.status).toBe(202);
    const body = data<{ project: { id: string }; jobId: string }>(created.json);
    projectId = body.project.id;
    const job = await pollJob(base, tokenA, projectId, body.jobId);
    expect(job['status']).toBe('completed');

    const overview = await api(base, 'GET', `/api/v1/projects/${projectId}/database`, tokenA);
    expect(overview.status).toBe(200);
    const db = data<{ database: { status: string }; health: string }>(overview.json);
    expect(db.database.status).toBe('running');
    expect(db.health).toBe('healthy');
  });

  it('masks credentials by default, reveals only to members (audited)', async () => {
    const masked = await api(
      base,
      'GET',
      `/api/v1/projects/${projectId}/database/connection`,
      tokenA,
    );
    expect(masked.status).toBe(200);
    const m = data<{ password: string; connectionString: string }>(masked.json);
    expect(m.password).toBe('••••••••');
    expect(m.connectionString).toContain(':•••@');
    expect(m.connectionString).not.toContain('supersecret');

    const revealed = await api(
      base,
      'GET',
      `/api/v1/projects/${projectId}/database/connection?reveal=true`,
      tokenA,
    );
    expect(revealed.status).toBe(200);
    expect(data<{ password: string }>(revealed.json).password).not.toBe('••••••••');
  });

  it('inspects schema and runs guarded SQL', async () => {
    const schema = await api(base, 'GET', `/api/v1/projects/${projectId}/database/schema`, tokenA);
    expect(schema.status).toBe(200);
    expect(data<{ tables: { name: string }[] }>(schema.json).tables[0]?.name).toBe('users');

    const q = await api(base, 'POST', `/api/v1/projects/${projectId}/database/query`, tokenA, {
      sql: 'select 1',
    });
    expect(q.status).toBe(200);
    expect(data<{ rows: unknown[] }>(q.json).rows).toHaveLength(1);

    const bad = await api(base, 'POST', `/api/v1/projects/${projectId}/database/query`, tokenA, {
      sql: 'select 1; drop table users',
    });
    expect(bad.status).toBe(400);
  });

  it('blocks cross-organization access everywhere (403)', async () => {
    expect((await api(base, 'GET', `/api/v1/projects/${projectId}`, tokenB)).status).toBe(403);
    expect((await api(base, 'GET', `/api/v1/projects/${projectId}/database`, tokenB)).status).toBe(
      403,
    );
    expect(
      (
        await api(base, 'POST', `/api/v1/projects/${projectId}/database/query`, tokenB, {
          sql: 'select 1',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await api(
          base,
          'GET',
          `/api/v1/projects/${projectId}/database/connection?reveal=true`,
          tokenB,
        )
      ).status,
    ).toBe(403);
    expect((await api(base, 'DELETE', `/api/v1/projects/${projectId}`, tokenB)).status).toBe(403);
  });

  it('collapses duplicate provisioning submits (idempotency)', async () => {
    const headers = { 'Idempotency-Key': 'e2e-dup-key' };
    const first = await api(
      base,
      'POST',
      '/api/v1/projects',
      tokenA,
      { name: 'Dup', slug: 'dup', organizationId: orgA },
      headers,
    );
    expect(first.status).toBe(202);
    const second = await api(
      base,
      'POST',
      '/api/v1/projects',
      tokenA,
      { name: 'Dup', slug: 'dup-other', organizationId: orgA },
      headers,
    );
    // Same key → same live job, no second project/database.
    expect(second.status).toBe(202);
    expect(data<{ jobId: string }>(second.json).jobId).toBe(
      data<{ jobId: string }>(first.json).jobId,
    );
  });

  it('validates input + exposes jobs and metrics', async () => {
    const bad = await api(base, 'POST', '/api/v1/projects', tokenA, {
      name: 'x',
      slug: 'BAD',
      organizationId: 'not-a-uuid',
    });
    expect(bad.status).toBe(400);

    const jobs = await api(base, 'GET', `/api/v1/projects/${projectId}/jobs`, tokenA);
    expect(jobs.status).toBe(200);
    expect(data<{ jobs: unknown[] }>(jobs.json).jobs.length).toBeGreaterThan(0);

    const metrics = await api(
      base,
      'GET',
      `/api/v1/projects/${projectId}/database/metrics`,
      tokenA,
    );
    expect(metrics.status).toBe(200);
    expect(data<{ connectionCount: number }>(metrics.json).connectionCount).toBe(1);
  });

  it('runs lifecycle actions and deletes cleanly', async () => {
    const stop = await api(base, 'POST', `/api/v1/projects/${projectId}/database/actions`, tokenA, {
      action: 'stop',
    });
    expect(stop.status).toBe(200);
    expect(data<{ status: string }>(stop.json).status).toBe('stopped');

    const del = await api(base, 'DELETE', `/api/v1/projects/${projectId}`, tokenA);
    expect(del.status).toBe(200);
    expect((await api(base, 'GET', `/api/v1/projects/${projectId}`, tokenA)).status).toBe(404);
  });
});
