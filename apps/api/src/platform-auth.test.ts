import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';

const JWT_SECRET = 'p'.repeat(48);

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

async function api(
  base: string,
  method: string,
  path: string,
  token: string | null,
  body?: unknown,
): Promise<{ status: number; headers: Headers; json: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: res.status,
    headers: res.headers,
    json: (await res.json()) as Record<string, unknown>,
  };
}

function data<T>(json: Record<string, unknown>): T {
  return (json['data'] ?? json) as T;
}

describe('phase 8 platform auth + org invites', () => {
  let base = '';
  let close: () => Promise<void> = async () => {};
  let tokenA = '';
  let userA = '';
  let orgId = '';

  beforeAll(async () => {
    const b = await boot();
    base = b.base;
    close = b.close;
  });

  afterAll(async () => {
    await close();
  });

  it('signs up, reports me, and logs in', async () => {
    const signup = await api(base, 'POST', '/api/v1/auth/signup', null, {
      email: 'dev@example.com',
      password: 'correct-horse-99',
      displayName: 'Dev',
    });
    expect(signup.status).toBe(201);
    expect(signup.headers.get('set-cookie')).toContain('cn_session=');
    expect(signup.headers.get('set-cookie')).toContain('HttpOnly');
    const created = data<{ user: { id: string }; token: string }>(signup.json);
    expect(created.user.id).toBeTruthy();
    expect(JSON.stringify(signup.json)).not.toContain('correct-horse');
    tokenA = created.token;
    userA = created.user.id;

    const me = await api(base, 'GET', '/api/v1/me', tokenA);
    expect(me.status).toBe(200);
    expect(data<{ user: { email: string } }>(me.json).user.email).toBe('dev@example.com');

    const login = await api(base, 'POST', '/api/v1/auth/login', null, {
      email: 'dev@example.com',
      password: 'correct-horse-99',
    });
    expect(login.status).toBe(200);

    const dupe = await api(base, 'POST', '/api/v1/auth/signup', null, {
      email: 'dev@example.com',
      password: 'another-long-1',
    });
    expect(dupe.status).toBe(409);
    const bad = await api(base, 'POST', '/api/v1/auth/login', null, {
      email: 'dev@example.com',
      password: 'wrong-password-1',
    });
    expect(bad.status).toBe(401);
    const unknown = await api(base, 'POST', '/api/v1/auth/login', null, {
      email: 'nobody@example.com',
      password: 'wrong-password-1',
    });
    expect(unknown.status).toBe(401);
    expect(await api(base, 'GET', '/api/v1/me', 'junk')).toHaveProperty('status', 401);
  });

  it('invites, looks up, and accepts org membership', async () => {
    const org = await api(base, 'POST', '/api/v1/organizations', tokenA, {
      name: 'Inv Org',
      slug: 'invorg',
    });
    expect(org.status).toBe(201);
    orgId = data<{ organization: { id: string } }>(org.json).organization.id;

    const created = await api(base, 'POST', `/api/v1/organizations/${orgId}/invites`, tokenA, {
      email: 'mate@example.com',
      role: 'member',
    });
    expect(created.status).toBe(201);
    const { invite, token } = data<{ invite: { id: string }; token: string }>(created.json);
    expect(invite.id).toBeTruthy();
    expect(token.startsWith('inv_')).toBe(true);

    const lookup = await api(base, 'GET', `/api/v1/invites/${token}`, null);
    expect(lookup.status).toBe(200);

    const signupB = await api(base, 'POST', '/api/v1/auth/signup', null, {
      email: 'mate@example.com',
      password: 'correct-horse-88',
    });
    const tokenB = data<{ token: string }>(signupB.json).token;
    const accept = await api(base, 'POST', `/api/v1/invites/${token}/accept`, tokenB, {});
    expect(accept.status).toBe(200);

    // The invitee now sees the org through membership.
    const meB = await api(base, 'GET', '/api/v1/me', tokenB);
    expect(
      data<{ organizations: { id: string; role: string }[] }>(meB.json).organizations,
    ).toContainEqual(expect.objectContaining({ id: orgId, role: 'member' }));

    // Double accept is rejected; bad tokens are 404.
    expect((await api(base, 'POST', `/api/v1/invites/${token}/accept`, tokenB, {})).status).toBe(
      409,
    );
    expect((await api(base, 'GET', '/api/v1/invites/inv_bogus', null)).status).toBe(404);
    expect(userA.length).toBeGreaterThan(0);
  });

  it('refuses invites from non-managers', async () => {
    const signupC = await api(base, 'POST', '/api/v1/auth/signup', null, {
      email: 'stranger@example.com',
      password: 'correct-horse-77',
    });
    const tokenC = data<{ token: string }>(signupC.json).token;
    const r = await api(base, 'POST', `/api/v1/organizations/${orgId}/invites`, tokenC, {
      email: 'x@example.com',
      role: 'viewer',
    });
    expect([403, 404]).toContain(r.status);
  });
});
