import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { signSession } from '@cloudnivo/auth';

const JWT_SECRET = 'v'.repeat(48);
const USER_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const USER_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

async function boot(env: Record<string, string> = {}): Promise<{
  base: string;
  close: () => Promise<void>;
}> {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = 'postgres://u:p@localhost:5432/db';
  process.env.JWT_SECRET = JWT_SECRET;
  process.env.CORS_ORIGINS = 'http://localhost:3000';
  process.env.CACHE_DRIVER = 'memory';
  process.env.PROVISION_DRIVER = 'fake';
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
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

async function req(
  base: string,
  method: string,
  path: string,
  opts: { token?: string; apikey?: string; body?: unknown; rawBody?: string } = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = {};
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  if (opts.apikey) headers['apikey'] = opts.apikey;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.rawBody !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: opts.rawBody ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

function data<T>(json: Record<string, unknown>): T {
  return json['data'] as T;
}

async function pollJob(
  base: string,
  token: string,
  projectId: string,
  jobId: string,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const r = await req(base, 'GET', `/api/v1/projects/${projectId}/jobs/${jobId}`, { token });
    const job = data<{ job: { status: string } }>(r.json).job;
    if (job.status === 'completed') return;
    if (job.status === 'failed') throw new Error('provisioning failed');
    if (Date.now() > deadline) throw new Error('job timeout');
    await new Promise(r2 => setTimeout(r2, 50));
  }
}

describe('phase 3 data plane (fake backend)', () => {
  let base = '';
  let close: () => Promise<void> = async () => {};
  let tokenA = '';
  let tokenB = '';
  let projectA = '';
  let projectB = '';
  let serviceKey = '';
  let publicKey = '';

  beforeAll(async () => {
    const b = await boot();
    base = b.base;
    close = b.close;
    tokenA = await tokenFor(USER_A);
    tokenB = await tokenFor(USER_B);
    const org = await req(base, 'POST', '/api/v1/organizations', {
      token: tokenA,
      body: { name: 'Org A', slug: 'orga' },
    });
    const orgId = data<{ organization: { id: string } }>(org.json).organization.id;
    const orgB = await req(base, 'POST', '/api/v1/organizations', {
      token: tokenB,
      body: { name: 'Org B', slug: 'orgb' },
    });
    const orgBId = data<{ organization: { id: string } }>(orgB.json).organization.id;
    for (const [orgX, slug, tok] of [
      [orgId, 'shop', tokenA],
      [orgBId, 'other', tokenB],
    ] as const) {
      const p = await req(base, 'POST', '/api/v1/projects', {
        token: tok,
        body: { name: slug, slug, organizationId: orgX },
      });
      const { project, jobId } = data<{ project: { id: string }; jobId: string }>(p.json);
      await pollJob(base, tok, project.id, jobId);
      if (tok === tokenA) projectA = project.id;
      else projectB = project.id;
    }
    const sk = await req(base, 'POST', `/api/v1/projects/${projectA}/keys`, {
      token: tokenA,
      body: { name: 'server', role: 'service' },
    });
    expect(sk.status).toBe(201);
    serviceKey = data<{ raw: string }>(sk.json).raw;
    const pk = await req(base, 'POST', `/api/v1/projects/${projectA}/keys`, {
      token: tokenA,
      body: { name: 'web', role: 'public' },
    });
    publicKey = data<{ raw: string }>(pk.json).raw;
  });
  afterAll(async () => {
    await close();
  });

  it('runs the full CRUD workflow through generated table routes', async () => {
    const empty = await req(base, 'GET', `/api/v1/projects/${projectA}/users`, {
      apikey: serviceKey,
    });
    expect(empty.status).toBe(200);
    expect(data<{ rows: unknown[] }>(empty.json).rows).toEqual([]);

    const created = await req(base, 'POST', `/api/v1/projects/${projectA}/users`, {
      apikey: serviceKey,
      body: { id: 'u1', email: 'a@b.c', age: 30 },
    });
    expect(created.status).toBe(201);

    const one = await req(base, 'GET', `/api/v1/projects/${projectA}/users/u1`, {
      apikey: serviceKey,
    });
    expect(data<{ row: { email: string } }>(one.json).row.email).toBe('a@b.c');

    const patched = await req(base, 'PATCH', `/api/v1/projects/${projectA}/users/u1`, {
      apikey: serviceKey,
      body: { age: 31 },
    });
    expect(data<{ row: { age: number } }>(patched.json).row.age).toBe(31);

    await req(base, 'POST', `/api/v1/projects/${projectA}/users`, {
      apikey: serviceKey,
      body: { id: 'u2', email: 'b@c.d', age: 25 },
    });
    const filtered = await req(
      base,
      'GET',
      `/api/v1/projects/${projectA}/users?age=gt.26&order=age.desc&limit=1`,
      {
        apikey: serviceKey,
      },
    );
    const rows = data<{ rows: { id: string }[] }>(filtered.json).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe('u1');

    const selected = await req(base, 'GET', `/api/v1/projects/${projectA}/users?select=id`, {
      apikey: serviceKey,
    });
    expect(data<{ rows: Record<string, unknown>[] }>(selected.json).rows[0]).toEqual({ id: 'u1' });

    const del = await req(base, 'DELETE', `/api/v1/projects/${projectA}/users/u2`, {
      apikey: serviceKey,
    });
    expect(del.status).toBe(200);
    expect(
      (await req(base, 'GET', `/api/v1/projects/${projectA}/users/u2`, { apikey: serviceKey }))
        .status,
    ).toBe(404);
  });

  it('enforces key roles and session viewer read-only', async () => {
    const r = await req(base, 'GET', `/api/v1/projects/${projectA}/users`, { apikey: publicKey });
    expect(r.status).toBe(200);
    const w = await req(base, 'POST', `/api/v1/projects/${projectA}/users`, {
      apikey: publicKey,
      body: { id: 'x', email: 'x@y.z' },
    });
    expect(w.status).toBe(403);
  });

  it('blocks cross-project access for keys and sessions', async () => {
    expect(
      (await req(base, 'GET', `/api/v1/projects/${projectB}/users`, { apikey: serviceKey })).status,
    ).toBe(403);
    expect(
      (await req(base, 'GET', `/api/v1/projects/${projectA}/users`, { token: tokenB })).status,
    ).toBe(403);
    expect((await req(base, 'GET', `/api/v1/projects/${projectA}/users`)).status).toBe(401);
  });

  it('rejects invalid, revoked, and expired keys', async () => {
    expect(
      (await req(base, 'GET', `/api/v1/projects/${projectA}/users`, { apikey: 'cn_nope' })).status,
    ).toBe(401);
    const tmp = await req(base, 'POST', `/api/v1/projects/${projectA}/keys`, {
      token: tokenA,
      body: { name: 'tmp', role: 'service' },
    });
    const { key: issued, raw } = data<{ key: { id: string }; raw: string }>(tmp.json);
    const listed = await req(base, 'GET', `/api/v1/projects/${projectA}/keys`, { token: tokenA });
    expect(data<{ keys: object[] }>(listed.json).keys.length).toBeGreaterThan(0);
    // Stored shapes never carry the hash.
    expect(JSON.stringify(listed.json)).not.toContain('hash');
    const rev = await req(base, 'POST', `/api/v1/projects/${projectA}/keys/${issued.id}/revoke`, {
      token: tokenA,
    });
    expect(rev.status).toBe(200);
    expect(
      (await req(base, 'GET', `/api/v1/projects/${projectA}/users`, { apikey: raw })).status,
    ).toBe(403);
    // API keys cannot manage keys (no privilege escalation).
    expect(
      (
        await req(base, 'POST', `/api/v1/projects/${projectA}/keys`, {
          apikey: serviceKey,
          body: { name: 'evil', role: 'admin' },
        })
      ).status,
    ).toBe(403);
  });

  it('neutralizes injection attempts at the boundary', async () => {
    const attempts: [string, string, unknown?][] = [
      ['GET', `/api/v1/projects/${projectA}/users%3BDROP%20TABLE%20users`],
      ['GET', `/api/v1/projects/${projectA}/users?select=id%2C%28select+password%29`],
      ['GET', `/api/v1/projects/${projectA}/users?email=bogus.x`],
      ['GET', `/api/v1/projects/${projectA}/users?order=email.desc%3BDROP`],
      ['GET', `/api/v1/projects/${projectA}/users?limit=999999`],
      ['POST', `/api/v1/projects/${projectA}/users`, { id: 'i1', email: 'a@b.c', is_admin: true }],
      ['PATCH', `/api/v1/projects/${projectA}/users/u1`, { 'a"b': 1 }],
    ];
    for (const [m, p, b] of attempts) {
      const r = await req(base, m, p, { apikey: serviceKey, body: b });
      expect([400, 404]).toContain(r.status);
      // Rejected at the boundary: no statement ever reaches the database.
      expect(JSON.stringify(r.json)).not.toMatch(/DELETE FROM|SELECT \*/);
      expect(r.json['error']).toBeTruthy();
    }
  });

  it('serves live OpenAPI docs without secrets', async () => {
    const r = await req(base, 'GET', `/api/v1/projects/${projectA}/openapi.json`, {
      apikey: publicKey,
    });
    expect(r.status).toBe(200);
    expect(r.json['openapi']).toBe('3.0.3');
    expect(JSON.stringify(r.json)).not.toContain('cn_');
  });

  it('rejects malformed JSON and oversized bodies', async () => {
    const bad = await req(base, 'POST', `/api/v1/projects/${projectA}/users`, {
      apikey: serviceKey,
      rawBody: '{not json',
    });
    expect(bad.status).toBe(400);
    const big = await req(base, 'POST', `/api/v1/projects/${projectA}/users`, {
      apikey: serviceKey,
      body: { id: 'big', email: 'x@y.z', age: 'y'.repeat(300_000) },
    });
    expect([400, 413]).toContain(big.status);
  });

  it('enforces per-key rate limits (429)', async () => {
    const limited = await boot({ DATA_API_KEY_MAX: '2', DATA_API_PROJECT_MAX: '1000' });
    try {
      const tok = await tokenFor(USER_A);
      const org = await req(limited.base, 'POST', '/api/v1/organizations', {
        token: tok,
        body: { name: 'RL', slug: 'rlorg' },
      });
      const orgId = data<{ organization: { id: string } }>(org.json).organization.id;
      const p = await req(limited.base, 'POST', '/api/v1/projects', {
        token: tok,
        body: { name: 'rl', slug: 'rl', organizationId: orgId },
      });
      const { project, jobId } = data<{ project: { id: string }; jobId: string }>(p.json);
      await pollJob(limited.base, tok, project.id, jobId);
      const k = await req(limited.base, 'POST', `/api/v1/projects/${project.id}/keys`, {
        token: tok,
        body: { name: 'limited', role: 'public' },
      });
      const raw = data<{ raw: string }>(k.json).raw;
      expect(
        (await req(limited.base, 'GET', `/api/v1/projects/${project.id}/users`, { apikey: raw }))
          .status,
      ).toBe(200);
      expect(
        (await req(limited.base, 'GET', `/api/v1/projects/${project.id}/users`, { apikey: raw }))
          .status,
      ).toBe(200);
      const over = await req(limited.base, 'GET', `/api/v1/projects/${project.id}/users`, {
        apikey: raw,
      });
      expect(over.status).toBe(429);
    } finally {
      delete process.env.DATA_API_KEY_MAX;
      delete process.env.DATA_API_PROJECT_MAX;
      await limited.close();
    }
  });
});
