import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { signSession } from '@cloudnivo/auth';

const JWT_SECRET = 'f'.repeat(48);
const USER_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const USER_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

const V1 = `module.exports.handler = async (req) => ({ status: 200, body: { v: 1, you: req.auth.userId, role: req.auth.role, echo: req.body ?? null } });`;
const V2 = `module.exports.handler = async (req) => { console.log('v2 ran'); return { status: 200, body: { v: 2 } }; };`;

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
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = { _raw: text };
  }
  return { status: res.status, json };
}

function data<T>(json: Record<string, unknown>): T {
  return (json['data'] ?? json) as T;
}

describe('phase 7 functions E2E (fake provider, worker runtime)', () => {
  let base = '';
  let close: () => Promise<void> = async () => {};
  let tokenA = '';
  let tokenB = '';
  let projectA = '';
  let projectB = '';

  beforeAll(async () => {
    const b = await boot();
    base = b.base;
    close = b.close;
    tokenA = await tokenFor(USER_A);
    tokenB = await tokenFor(USER_B);
    const mkOrg = async (tok: string, slug: string): Promise<string> => {
      const r = await api(base, 'POST', '/api/v1/organizations', tok, { name: slug, slug });
      expect(r.status).toBe(201);
      return data<{ organization: { id: string } }>(r.json).organization.id;
    };
    const orgA = await mkOrg(tokenA, 'fnorga');
    const orgB = await mkOrg(tokenB, 'fnorgb');
    const mkProject = async (tok: string, org: string, slug: string): Promise<string> => {
      const p = await api(base, 'POST', '/api/v1/projects', tok, {
        name: slug,
        slug,
        organizationId: org,
      });
      expect(p.status).toBe(202);
      const { project, jobId } = data<{ project: { id: string }; jobId: string }>(p.json);
      const deadline = Date.now() + 10_000;
      for (;;) {
        const j = await api(base, 'GET', `/api/v1/projects/${project.id}/jobs/${jobId}`, tok);
        const st = data<{ job: { status: string } }>(j.json).job.status;
        if (st === 'completed') break;
        if (st === 'failed' || Date.now() > deadline) throw new Error('provisioning failed');
        await new Promise(r => setTimeout(r, 50));
      }
      return project.id;
    };
    projectA = await mkProject(tokenA, orgA, 'fnshop');
    projectB = await mkProject(tokenB, orgB, 'fnother');
  });

  afterAll(async () => {
    await close();
  });

  async function deployAndWait(slug: string, source: string): Promise<string> {
    const d = await api(
      base,
      'POST',
      `/api/v1/projects/${projectA}/functions/${slug}/deploy`,
      tokenA,
      {
        source,
      },
    );
    expect(d.status).toBe(202);
    const jobId = data<{ job: { id: string } }>(d.json).job.id;
    const deadline = Date.now() + 15_000;
    for (;;) {
      const g = await api(
        base,
        'GET',
        `/api/v1/projects/${projectA}/functions/${slug}/deployments/${jobId}`,
        tokenA,
      );
      expect(g.status).toBe(200);
      const job = data<{ deployment: { status: string; lastError: string | null } }>(
        g.json,
      ).deployment;
      if (job.status === 'ready') return jobId;
      if (job.status === 'failed') throw new Error(`deploy failed: ${job.lastError}`);
      if (Date.now() > deadline) throw new Error('deploy timed out');
      await new Promise(r => setTimeout(r, 50));
    }
  }

  it('creates, deploys, invokes with auth context, logs, and versions', async () => {
    const c = await api(base, 'POST', `/api/v1/projects/${projectA}/functions`, tokenA, {
      name: 'Greeter',
      slug: 'greeter',
      description: 'says hi',
    });
    expect(c.status).toBe(201);
    expect(data<{ function: { id: string } }>(c.json).function.id).toBeTruthy();

    await deployAndWait('greeter', V1);
    const got = await api(base, 'GET', `/api/v1/projects/${projectA}/functions/greeter`, tokenA);
    expect(
      data<{ function: { status: string; activeVersion: number } }>(got.json).function,
    ).toMatchObject({
      status: 'ready',
      activeVersion: 1,
    });

    const invoked = await api(
      base,
      'POST',
      `/api/v1/projects/${projectA}/functions/greeter/invoke`,
      tokenA,
      {
        n: 3,
      },
    );
    expect(invoked.status).toBe(200);
    expect(data<{ result: unknown; version: number }>(invoked.json)).toMatchObject({
      result: { v: 1, you: USER_A, echo: { n: 3 } },
      version: 1,
    });

    const logs = await api(
      base,
      'GET',
      `/api/v1/projects/${projectA}/functions/greeter/logs`,
      tokenA,
    );
    expect(logs.status).toBe(200);

    await deployAndWait('greeter', V2);
    const v2 = await api(
      base,
      'POST',
      `/api/v1/projects/${projectA}/functions/greeter/invoke`,
      tokenA,
      {},
    );
    expect(data<{ result: unknown; version: number }>(v2.json)).toMatchObject({
      result: { v: 2 },
      version: 2,
    });

    const versions = await api(
      base,
      'GET',
      `/api/v1/projects/${projectA}/functions/greeter/versions`,
      tokenA,
    );
    expect(data<{ versions: unknown[] }>(versions.json).versions).toHaveLength(2);

    // Rollback to v1 executes v1 again.
    const rb = await api(
      base,
      'POST',
      `/api/v1/projects/${projectA}/functions/greeter/versions/1/activate`,
      tokenA,
      {},
    );
    expect(rb.status).toBe(200);
    const back = await api(
      base,
      'POST',
      `/api/v1/projects/${projectA}/functions/greeter/invoke`,
      tokenA,
      {},
    );
    expect(data<{ result: unknown }>(back.json).result).toMatchObject({ v: 1 });
  });

  it('manages env vars with secret masking', async () => {
    const put = await api(
      base,
      'PUT',
      `/api/v1/projects/${projectA}/functions/greeter/env`,
      tokenA,
      {
        key: 'API_TOKEN',
        value: 'tok-env-secret-999',
        secret: true,
      },
    );
    expect(put.status).toBe(200);
    const list = await api(
      base,
      'GET',
      `/api/v1/projects/${projectA}/functions/greeter/env`,
      tokenA,
    );
    const vars = data<{ env: { key: string; value: string; secret: boolean }[] }>(list.json).env;
    const token = vars.find(e => e.key === 'API_TOKEN');
    expect(token?.secret).toBe(true);
    expect(token?.value).not.toContain('env-secret-999');
  });

  it('enforces auth, isolation, and safe failures', async () => {
    // Unauthenticated invoke → 401.
    expect(
      (await api(base, 'POST', `/api/v1/projects/${projectA}/functions/greeter/invoke`, null, {}))
        .status,
    ).toBe(401);
    // Cross-project invoke → 403/404, never the other project's result.
    const cross = await api(
      base,
      'POST',
      `/api/v1/projects/${projectA}/functions/greeter/invoke`,
      tokenB,
      {},
    );
    expect([403, 404]).toContain(cross.status);
    // Nonexistent function → 404.
    expect(
      (await api(base, 'POST', `/api/v1/projects/${projectA}/functions/nope/invoke`, tokenA, {}))
        .status,
    ).toBe(404);
    // Broken source deploy → job FAILED, function FAILED (never READY).
    const bad = await api(base, 'POST', `/api/v1/projects/${projectA}/functions`, tokenA, {
      name: 'Broken',
      slug: 'broken',
    });
    expect(bad.status).toBe(201);
    const d = await api(
      base,
      'POST',
      `/api/v1/projects/${projectA}/functions/broken/deploy`,
      tokenA,
      {
        source: 'this is {{{ not js',
      },
    );
    expect(d.status).toBe(202);
    const jobId = data<{ job: { id: string } }>(d.json).job.id;
    const deadline = Date.now() + 15_000;
    for (;;) {
      const g = await api(
        base,
        'GET',
        `/api/v1/projects/${projectA}/functions/broken/deployments/${jobId}`,
        tokenA,
      );
      const job = data<{ deployment: { status: string } }>(g.json).deployment;
      if (job.status === 'failed') break;
      if (job.status === 'ready') throw new Error('broken source reported READY');
      if (Date.now() > deadline) throw new Error('deploy timed out');
      await new Promise(r => setTimeout(r, 50));
    }
    // Oversized source → 413.
    const big = await api(
      base,
      'POST',
      `/api/v1/projects/${projectA}/functions/broken/deploy`,
      tokenA,
      {
        source: `x${'y'.repeat(6 * 1024 * 1024)}`,
      },
    );
    expect(big.status).toBe(413);
  });

  it('deletes and then rejects invocation', async () => {
    const del = await api(base, 'DELETE', `/api/v1/projects/${projectA}/functions/greeter`, tokenA);
    expect(del.status).toBe(204);
    expect(
      (await api(base, 'POST', `/api/v1/projects/${projectA}/functions/greeter/invoke`, tokenA, {}))
        .status,
    ).toBe(404);
    expect(projectB.length).toBeGreaterThan(0);
  });
});
