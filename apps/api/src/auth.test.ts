import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { signSession } from '@cloudnivo/auth';

const JWT_SECRET = 'w'.repeat(48);
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

async function platformToken(sub: string): Promise<string> {
  return signSession({ sub, email: `${sub}@example.com` }, { jwtSecret: JWT_SECRET });
}

async function req(
  base: string,
  method: string,
  path: string,
  opts: {
    token?: string;
    customer?: string;
    apikey?: string;
    body?: unknown;
    rawBody?: string;
  } = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = {};
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  if (opts.customer) headers['Authorization'] = `Bearer ${opts.customer}`;
  if (opts.apikey) headers['apikey'] = opts.apikey;
  if (opts.body !== undefined || opts.rawBody !== undefined)
    headers['Content-Type'] = 'application/json';
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

async function makeProject(
  base: string,
  token: string,
  orgSlug: string,
  slug: string,
): Promise<string> {
  const org = await req(base, 'POST', '/api/v1/organizations', {
    token,
    body: { name: orgSlug, slug: orgSlug },
  });
  const orgId = data<{ organization: { id: string } }>(org.json).organization.id;
  const p = await req(base, 'POST', '/api/v1/projects', {
    token,
    body: { name: slug, slug, organizationId: orgId },
  });
  const { project, jobId } = data<{ project: { id: string }; jobId: string }>(p.json);
  const deadline = Date.now() + 10_000;
  for (;;) {
    const j = await req(base, 'GET', `/api/v1/projects/${project.id}/jobs/${jobId}`, { token });
    const st = data<{ job: { status: string } }>(j.json).job.status;
    if (st === 'completed') break;
    if (st === 'failed' || Date.now() > deadline) throw new Error('provisioning failed');
    await new Promise(r => setTimeout(r, 50));
  }
  return project.id;
}

describe('phase 4 customer auth E2E (§21)', () => {
  let base = '';
  let close: () => Promise<void> = async () => {};
  let tokenA = '';
  let projectA = '';

  beforeAll(async () => {
    const b = await boot();
    base = b.base;
    close = b.close;
    tokenA = await platformToken(USER_A);
    projectA = await makeProject(base, tokenA, 'authorg', 'authshop');
  });
  afterAll(async () => {
    await close();
  });

  it('signup → verify → login → tokens → me → refresh → logout → revoked', async () => {
    const A = `/api/v1/projects/${projectA}/auth`;
    const signup = await req(base, 'POST', `${A}/signup`, {
      body: {
        email: 'end@example.com',
        password: 'correct-horse-1',
        userMetadata: { display_name: 'E' },
      },
    });
    expect(signup.status).toBe(201);
    const vToken = data<{ verificationToken: string }>(signup.json).verificationToken;
    expect(typeof vToken).toBe('string');

    const verify = await req(base, 'POST', `${A}/verify`, { body: { token: vToken } });
    expect(verify.status).toBe(200);
    expect(data<{ user: { emailVerified: boolean } }>(verify.json).user.emailVerified).toBe(true);

    const login = await req(base, 'POST', `${A}/token`, {
      body: { email: 'end@example.com', password: 'correct-horse-1' },
    });
    expect(login.status).toBe(200);
    const { tokens, user } = data<{
      tokens: { accessToken: string; refreshToken: string };
      user: { id: string };
    }>(login.json);

    const me = await req(base, 'GET', `${A}/user`, { customer: tokens.accessToken });
    expect(me.status).toBe(200);
    expect(data<{ user: { id: string } }>(me.json).user.id).toBe(user.id);

    const refreshed = await req(base, 'POST', `${A}/refresh`, {
      body: { refresh_token: tokens.refreshToken },
    });
    expect(refreshed.status).toBe(200);
    const tokens2 = data<{ tokens: { accessToken: string; refreshToken: string } }>(
      refreshed.json,
    ).tokens;
    expect(tokens2.refreshToken).not.toBe(tokens.refreshToken);

    // Reuse of the retired refresh token is theft → session dies.
    const reuse = await req(base, 'POST', `${A}/refresh`, {
      body: { refresh_token: tokens.refreshToken },
    });
    expect(reuse.status).toBe(401);
    const dead = await req(base, 'POST', `${A}/refresh`, {
      body: { refresh_token: tokens2.refreshToken },
    });
    expect(dead.status).toBe(401);

    // Fresh login → logout by access token → session gone.
    const login2 = await req(base, 'POST', `${A}/token`, {
      body: { email: 'end@example.com', password: 'correct-horse-1' },
    });
    const t2 = data<{ tokens: { accessToken: string } }>(login2.json).tokens;
    const out = await req(base, 'POST', `${A}/logout`, { customer: t2.accessToken });
    expect(out.status).toBe(200);
    // Revoked session invalidates the access token everywhere.
    expect((await req(base, 'GET', `${A}/sessions`, { customer: t2.accessToken })).status).toBe(
      401,
    );
    expect(
      (await req(base, 'GET', `/api/v1/projects/${projectA}/users`, { customer: t2.accessToken }))
        .status,
    ).toBe(401);
  });

  it('reset + change password, sessions admin', async () => {
    const A = `/api/v1/projects/${projectA}/auth`;
    await req(base, 'POST', `${A}/signup`, {
      body: { email: 'pw@example.com', password: 'old-password-1' },
    });
    // Enumeration-neutral, even for ghosts.
    expect(
      (await req(base, 'POST', `${A}/reset-request`, { body: { email: 'ghost@example.com' } }))
        .status,
    ).toBe(200);
    const rr = await req(base, 'POST', `${A}/reset-request`, { body: { email: 'pw@example.com' } });
    const resetToken = data<{ resetToken: string }>(rr.json).resetToken;
    expect(
      (
        await req(base, 'POST', `${A}/reset`, {
          body: { token: resetToken, password: 'new-password-2' },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await req(base, 'POST', `${A}/reset`, {
          body: { token: resetToken, password: 'new-password-3' },
        })
      ).status,
    ).toBe(400);
    const login = await req(base, 'POST', `${A}/token`, {
      body: { email: 'pw@example.com', password: 'new-password-2' },
    });
    const access = data<{ tokens: { accessToken: string } }>(login.json).tokens.accessToken;
    expect(
      (
        await req(base, 'POST', `${A}/change`, {
          customer: access,
          body: { currentPassword: 'nope-0000', newPassword: 'x-new-pass-1' },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await req(base, 'POST', `${A}/change`, {
          customer: access,
          body: { currentPassword: 'new-password-2', newPassword: 'newer-pass-3' },
        })
      ).status,
    ).toBe(200);
    const sess = await req(base, 'GET', `${A}/sessions`, { customer: access });
    expect(sess.status).toBe(200);
    expect(data<{ sessions: unknown[] }>(sess.json).sessions.length).toBeGreaterThan(0);
  });

  it('dashboard admin manages users; users cannot touch admin routes', async () => {
    const A = `/api/v1/projects/${projectA}/auth`;
    const s = await req(base, 'POST', `${A}/signup`, {
      body: { email: 'managed@example.com', password: 'long-enough-1' },
    });
    const uid = data<{ user: { id: string } }>(s.json).user.id;
    // Customer token cannot list users.
    const login = await req(base, 'POST', `${A}/token`, {
      body: { email: 'managed@example.com', password: 'long-enough-1' },
    });
    const access = data<{ tokens: { accessToken: string } }>(login.json).tokens.accessToken;
    expect((await req(base, 'GET', `${A}/admin/users`, { customer: access })).status).toBe(403);
    // Platform admin can.
    const list = await req(base, 'GET', `${A}/admin/users`, { token: tokenA });
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.json)).not.toContain('scrypt:');
    const dis = await req(base, 'PATCH', `${A}/admin/users`, {
      token: tokenA,
      body: { id: uid, status: 'disabled' },
    });
    expect(dis.status).toBe(200);
    expect(
      (
        await req(base, 'POST', `${A}/token`, {
          body: { email: 'managed@example.com', password: 'long-enough-1' },
        })
      ).status,
    ).toBe(403);
    const del = await req(base, 'DELETE', `${A}/admin/users`, { token: tokenA, body: { id: uid } });
    expect(del.status).toBe(200);
  });

  it('project isolation matrix (A⇄B denied everywhere)', async () => {
    const tokenB = await platformToken(USER_B);
    const projectB = await makeProject(base, tokenB, 'authorgb', 'authshopb');
    const A = `/api/v1/projects/${projectA}/auth`;
    const B = `/api/v1/projects/${projectB}/auth`;
    const s = await req(base, 'POST', `${A}/signup`, {
      body: { email: 'iso@example.com', password: 'long-enough-1' },
    });
    const vToken = data<{ verificationToken: string }>(s.json).verificationToken;
    await req(base, 'POST', `${A}/verify`, { body: { token: vToken } });
    const login = await req(base, 'POST', `${A}/token`, {
      body: { email: 'iso@example.com', password: 'long-enough-1' },
    });
    const access = data<{ tokens: { accessToken: string } }>(login.json).tokens.accessToken;
    // A-user token against B data + B auth → denied (403: valid credential,
    // wrong project — never 401, never data).
    expect(
      (await req(base, 'GET', `/api/v1/projects/${projectB}/users`, { customer: access })).status,
    ).toBe(403);
    expect((await req(base, 'GET', `${B}/user`, { customer: access })).status).toBe(403);
    // A admin (platform) cannot manage B users… B has none, but B admin routes need B membership:
    expect((await req(base, 'GET', `${B}/admin/users`, { token: tokenA })).status).toBe(403);
    // B user cannot read A's data.
    const sb = await req(base, 'POST', `${B}/signup`, {
      body: { email: 'buser@example.com', password: 'long-enough-1' },
    });
    const bv = data<{ verificationToken: string }>(sb.json).verificationToken;
    await req(base, 'POST', `${B}/verify`, { body: { token: bv } });
    const lb = await req(base, 'POST', `${B}/token`, {
      body: { email: 'buser@example.com', password: 'long-enough-1' },
    });
    const bAccess = data<{ tokens: { accessToken: string } }>(lb.json).tokens.accessToken;
    expect(
      (await req(base, 'GET', `/api/v1/projects/${projectA}/users`, { customer: bAccess })).status,
    ).toBe(403);
  });

  it('customer JWTs drive the data plane with owner scoping', async () => {
    const A = `/api/v1/projects/${projectA}/auth`;
    for (const [em, _id] of [
      ['o1@example.com', 'u1'],
      ['o2@example.com', 'u2'],
    ] as const) {
      await req(base, 'POST', `${A}/signup`, { body: { email: em, password: 'long-enough-1' } });
    }
    const l1 = await req(base, 'POST', `${A}/token`, {
      body: { email: 'o1@example.com', password: 'long-enough-1' },
    });
    const l2 = await req(base, 'POST', `${A}/token`, {
      body: { email: 'o2@example.com', password: 'long-enough-1' },
    });
    const t1 = data<{ tokens: { accessToken: string } }>(l1.json).tokens.accessToken;
    const t2 = data<{ tokens: { accessToken: string } }>(l2.json).tokens.accessToken;
    // posts table carries user_id → owner-scoped.
    expect(
      (
        await req(base, 'POST', `/api/v1/projects/${projectA}/posts`, {
          customer: t1,
          body: { id: 'p1', title: 'hello' },
        })
      ).status,
    ).toBe(201);
    // Forged ownership rejected.
    const u1 = data<{ user: { id: string } }>(l1.json).user;
    void u1;
    expect(
      (
        await req(base, 'POST', `/api/v1/projects/${projectA}/posts`, {
          customer: t2,
          body: { id: 'p2', title: 'x', user_id: 'someone-else' },
        })
      ).status,
    ).toBe(403);
    // u2 cannot see u1's row (404, no oracle) and cannot list it.
    expect(
      (await req(base, 'GET', `/api/v1/projects/${projectA}/posts/p1`, { customer: t2 })).status,
    ).toBe(404);
    const list = await req(base, 'GET', `/api/v1/projects/${projectA}/posts`, { customer: t2 });
    expect(data<{ rows: unknown[] }>(list.json).rows).toHaveLength(0);
    const own = await req(base, 'GET', `/api/v1/projects/${projectA}/posts`, { customer: t1 });
    expect(data<{ rows: { id: string }[] }>(own.json).rows.map(r => r.id)).toEqual(['p1']);
  });

  it('auth endpoints resist abuse (rate limits, bad tokens, mass assignment)', async () => {
    const A = `/api/v1/projects/${projectA}/auth`;
    // Mass assignment via metadata blocked.
    const bad = await req(base, 'POST', `${A}/signup`, {
      body: {
        email: 'evil@example.com',
        password: 'long-enough-1',
        userMetadata: { role: 'admin' },
      },
    });
    expect(bad.status).toBe(400);
    // Tampered / foreign tokens rejected.
    expect((await req(base, 'GET', `${A}/user`, { customer: 'x.y.z' })).status).toBe(401);
    // Brute-force bucket trips quickly (AUTH_RATE_MAX=10/test default… assert 429 eventually).
    let limited = false;
    for (let i = 0; i < 14; i += 1) {
      const r = await req(base, 'POST', `${A}/token`, {
        body: { email: 'nobody-here@example.com', password: 'wrong-0000' },
      });
      if (r.status === 429) {
        limited = true;
        break;
      }
      expect(r.status).toBe(401);
    }
    expect(limited).toBe(true);
  });

  it('project CORS config is admin-gated and fail-closed', async () => {
    const A = `/api/v1/projects/${projectA}/auth`;
    expect((await req(base, 'GET', `${A}/config`, { token: tokenA })).status).toBe(200);
    const bad = await req(base, 'PATCH', `${A}/config`, {
      token: tokenA,
      body: { allowedOrigins: ['*'] },
    });
    expect(bad.status).toBe(400);
    const good = await req(base, 'PATCH', `${A}/config`, {
      token: tokenA,
      body: { allowedOrigins: ['https://app.example.com'] },
    });
    expect(good.status).toBe(200);
  });
});
