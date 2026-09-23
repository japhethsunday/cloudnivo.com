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
    // Password change revokes all sessions: old token must be dead.
    const stale = await req(base, 'GET', `${A}/sessions`, { customer: access });
    expect(stale.status).toBe(401);
    const relogin = await req(base, 'POST', `${A}/token`, {
      body: { email: 'pw@example.com', password: 'newer-pass-3' },
    });
    expect(relogin.status).toBe(200);
    const fresh = data<{ tokens: { accessToken: string } }>(relogin.json).tokens.accessToken;
    const sess = await req(base, 'GET', `${A}/sessions`, { customer: fresh });
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

describe('customer auth extensions E2E', () => {
  let base = '';
  let close: () => Promise<void> = async () => {};
  let tokenA = '';
  let projectA = '';

  beforeAll(async () => {
    const b = await boot();
    base = b.base;
    close = b.close;
    tokenA = await platformToken(USER_A);
    projectA = await makeProject(base, tokenA, 'extorg', 'extshop');
  });
  afterAll(async () => {
    await close();
  });

  it('anonymous sign-in converts to a real identity', async () => {
    const A = `/api/v1/projects/${projectA}/auth`;
    const anon = await req(base, 'POST', `${A}/anonymous`, { body: {} });
    expect(anon.status).toBe(200);
    const anonUser = data<{ user: { id: string; isAnonymous: boolean; role: string } }>(
      anon.json,
    ).user;
    expect(anonUser.isAnonymous).toBe(true);
    expect(anonUser.role).toBe('anonymous');
    expect(JSON.stringify(anon.json)).not.toContain('passwordHash');
    const anonToken = data<{ tokens: { accessToken: string } }>(anon.json).tokens.accessToken;
    const me = await req(base, 'GET', `${A}/user`, { customer: anonToken });
    expect(me.status).toBe(200);
    const converted = await req(base, 'POST', `${A}/convert`, {
      customer: anonToken,
      body: { email: 'human-ext@example.com', password: 'long-enough-1' },
    });
    expect(converted.status).toBe(200);
    expect(data<{ user: { isAnonymous: boolean } }>(converted.json).user.isAnonymous).toBe(false);
    const login = await req(base, 'POST', `${A}/token`, {
      body: { email: 'human-ext@example.com', password: 'long-enough-1' },
    });
    expect(login.status).toBe(200);
  });

  it('email OTP logs in single-use', async () => {
    const A = `/api/v1/projects/${projectA}/auth`;
    const s = await req(base, 'POST', `${A}/signup`, {
      body: { email: 'otp-ext@example.com', password: 'long-enough-1' },
    });
    expect(s.status).toBe(201);
    const rq = await req(base, 'POST', `${A}/otp-request`, {
      body: { email: 'otp-ext@example.com', purpose: 'login' },
    });
    expect(rq.status).toBe(200);
    expect(data<{ code: string }>(rq.json).code).toMatch(/^\d{6}$/);
    const code = data<{ code: string }>(rq.json).code;
    const v = await req(base, 'POST', `${A}/otp-verify`, {
      body: { email: 'otp-ext@example.com', code },
    });
    expect(v.status).toBe(200);
    expect(data<{ tokens: { tokenType: string } }>(v.json).tokens.tokenType).toBe('bearer');
    // Single use.
    expect(
      (
        await req(base, 'POST', `${A}/otp-verify`, {
          body: { email: 'otp-ext@example.com', code },
        })
      ).status,
    ).toBe(410);
    // Unknown emails still get a neutral response.
    expect(
      (
        await req(base, 'POST', `${A}/otp-request`, {
          body: { email: 'ghost-ext@example.com' },
        })
      ).status,
    ).toBe(200);
  });

  it('magic links sign in and verify email', async () => {
    const A = `/api/v1/projects/${projectA}/auth`;
    await req(base, 'POST', `${A}/signup`, {
      body: { email: 'magic-ext@example.com', password: 'long-enough-1' },
    });
    const rq = await req(base, 'POST', `${A}/magic-request`, {
      body: { email: 'magic-ext@example.com' },
    });
    expect(rq.status).toBe(200);
    const magicToken = data<{ magicToken: string }>(rq.json).magicToken;
    expect(magicToken.length).toBeGreaterThan(10);
    const c = await req(base, 'POST', `${A}/magic-consume`, { body: { token: magicToken } });
    expect(c.status).toBe(200);
    expect(data<{ user: { emailVerified: boolean } }>(c.json).user.emailVerified).toBe(true);
    expect(
      (await req(base, 'POST', `${A}/magic-consume`, { body: { token: magicToken } })).status,
    ).toBe(400);
  });

  it('totp mfa gates password login until verified', async () => {
    const A = `/api/v1/projects/${projectA}/auth`;
    await req(base, 'POST', `${A}/signup`, {
      body: { email: 'mfa-ext@example.com', password: 'long-enough-1' },
    });
    const login0 = await req(base, 'POST', `${A}/token`, {
      body: { email: 'mfa-ext@example.com', password: 'long-enough-1' },
    });
    const session0 = data<{ tokens: { accessToken: string } }>(login0.json).tokens.accessToken;
    const enroll = await req(base, 'POST', `${A}/mfa-enroll`, { customer: session0 });
    expect(enroll.status).toBe(200);
    const secret = data<{ secret: string }>(enroll.json).secret;
    // Compute the live code like an authenticator app would.
    const { totpNow } = await import('@cloudnivo/auth');
    const confirm = await req(base, 'POST', `${A}/mfa-confirm`, {
      customer: session0,
      body: { code: totpNow(secret) },
    });
    expect(confirm.status).toBe(200);
    expect(data<{ backupCodes: string[] }>(confirm.json).backupCodes).toHaveLength(10);
    // Password login now challenges...
    const challenged = await req(base, 'POST', `${A}/token`, {
      body: { email: 'mfa-ext@example.com', password: 'long-enough-1' },
    });
    expect(challenged.status).toBe(200);
    expect(data<{ mfaRequired: boolean }>(challenged.json).mfaRequired).toBe(true);
    const ticket = data<{ mfaTicket: string }>(challenged.json).mfaTicket;
    // ...wrong code fails, live code opens the session.
    expect(
      (
        await req(base, 'POST', `${A}/mfa-verify`, {
          body: { mfaTicket: ticket, code: '000000' },
        })
      ).status,
    ).toBe(401);
    const challenged2 = await req(base, 'POST', `${A}/token`, {
      body: { email: 'mfa-ext@example.com', password: 'long-enough-1' },
    });
    const ticket2 = data<{ mfaTicket: string }>(challenged2.json).mfaTicket;
    const verified = await req(base, 'POST', `${A}/mfa-verify`, {
      body: { mfaTicket: ticket2, code: totpNow(secret) },
    });
    expect(verified.status).toBe(200);
  });

  it('phone otp verifies numbers; secrets never leak', async () => {
    const A = `/api/v1/projects/${projectA}/auth`;
    await req(base, 'POST', `${A}/signup`, {
      body: { email: 'phone-ext@example.com', password: 'long-enough-1' },
    });
    const login = await req(base, 'POST', `${A}/token`, {
      body: { email: 'phone-ext@example.com', password: 'long-enough-1' },
    });
    const session = data<{ tokens: { accessToken: string } }>(login.json).tokens.accessToken;
    expect(
      (
        await req(base, 'POST', `${A}/phone`, {
          customer: session,
          body: { phone: 'bad' },
        })
      ).status,
    ).toBe(400);
    const set = await req(base, 'POST', `${A}/phone`, {
      customer: session,
      body: { phone: '+15550001111' },
    });
    expect(set.status).toBe(200);
    const rq = await req(base, 'POST', `${A}/phone-otp-request`, { customer: session });
    expect(rq.status).toBe(200);
    // Dev driver honestly reports non-delivery; no secrets in responses.
    expect(JSON.stringify(rq.json)).not.toContain('+15550001111');
  });
});

/**
 * Passkeys, end to end over HTTP: register a credential produced by a real
 * keypair, then log in with an assertion that key signs. Nothing here is
 * mocked — the same verifier that runs in production checks these bytes.
 */
describe('passkeys E2E', () => {
  let base = '';
  let close: () => Promise<void> = async () => {};
  let projectA = '';
  let userToken = '';

  const RP_ID = 'localhost';
  const ORIGIN = 'http://localhost:3000';

  const b64u = (b: Buffer): string => b.toString('base64url');

  // CBOR writers: only the shapes an authenticator emits.
  const cborUint = (n: number): Buffer => {
    if (n < 24) return Buffer.from([n]);
    if (n < 256) return Buffer.from([0x18, n]);
    if (n < 65536) return Buffer.from([0x19, n >> 8, n & 0xff]);
    const b = Buffer.alloc(5);
    b[0] = 0x1a;
    b.writeUInt32BE(n, 1);
    return b;
  };
  const cborNeg = (n: number): Buffer => {
    const b = cborUint(-1 - n);
    b[0] = (b[0] as number) | 0x20;
    return b;
  };
  const cborBytes = (v: Buffer): Buffer => {
    const h = cborUint(v.length);
    h[0] = (h[0] as number) | 0x40;
    return Buffer.concat([h, v]);
  };
  const cborText = (v: string): Buffer => {
    const b = Buffer.from(v, 'utf8');
    const h = cborUint(b.length);
    h[0] = (h[0] as number) | 0x60;
    return Buffer.concat([h, b]);
  };
  const cborMap = (entries: [Buffer, Buffer][]): Buffer => {
    const h = cborUint(entries.length);
    h[0] = (h[0] as number) | 0xa0;
    return Buffer.concat([h, ...entries.flatMap(([k, v]) => [k, v])]);
  };

  beforeAll(async () => {
    const b = await boot();
    base = b.base;
    close = b.close;
    const tokenA = await platformToken(USER_A);
    projectA = await makeProject(base, tokenA, 'pkorg', 'pkshop');
    // Bind the project's WebAuthn origin explicitly; the server derives rpId
    // from it rather than trusting anything in the request.
    await req(base, 'PATCH', `/api/v1/projects/${projectA}/auth/config`, {
      token: tokenA,
      body: { allowedOrigins: [ORIGIN] },
    });
    const A = `/api/v1/projects/${projectA}/auth`;
    await req(base, 'POST', `${A}/signup`, {
      body: { email: 'passkey@example.com', password: 'Str0ng!Passw0rd#2024' },
    });
    const login = await req(base, 'POST', `${A}/token`, {
      body: {
        grant_type: 'password',
        email: 'passkey@example.com',
        password: 'Str0ng!Passw0rd#2024',
      },
    });
    userToken = data<{ tokens: { accessToken: string } }>(login.json).tokens.accessToken;
  });
  afterAll(async () => {
    await close();
  });

  it('registers a real credential and signs in with it', async () => {
    const { createHash, createSign, generateKeyPairSync, randomBytes } =
      await import('node:crypto');
    const A = `/api/v1/projects/${projectA}/auth`;

    const kp = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const spki = kp.publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
    const point = spki.subarray(spki.length - 65);
    const cose = cborMap([
      [cborUint(1), cborUint(2)],
      [cborUint(3), cborNeg(-7)],
      [cborNeg(-1), cborUint(1)],
      [cborNeg(-2), cborBytes(point.subarray(1, 33))],
      [cborNeg(-3), cborBytes(point.subarray(33, 65))],
    ]);
    const credentialId = randomBytes(32);

    const authData = (flags: number, withCred: boolean): Buffer => {
      const head = Buffer.alloc(5);
      head[0] = flags;
      head.writeUInt32BE(0, 1);
      const base37 = Buffer.concat([createHash('sha256').update(RP_ID).digest(), head]);
      if (!withCred) return base37;
      const len = Buffer.alloc(2);
      len.writeUInt16BE(credentialId.length, 0);
      return Buffer.concat([base37, Buffer.alloc(16), len, credentialId, cose]);
    };
    const clientData = (type: string, challenge: string): string =>
      b64u(Buffer.from(JSON.stringify({ type, challenge, origin: ORIGIN, crossOrigin: false })));

    // ── register ──
    const begin = await req(base, 'POST', `${A}/passkeys/register/begin`, { customer: userToken });
    expect(begin.status).toBe(200);
    const reg = data<{ challenge: string; rpId: string }>(begin.json);
    expect(reg.rpId).toBe(RP_ID);

    const attestation = b64u(
      cborMap([
        [cborText('fmt'), cborText('none')],
        [cborText('attStmt'), cborMap([])],
        [cborText('authData'), cborBytes(authData(0x45, true))],
      ]),
    );
    const finished = await req(base, 'POST', `${A}/passkeys/register/finish`, {
      customer: userToken,
      body: {
        challenge: reg.challenge,
        attestationObject: attestation,
        clientDataJSON: clientData('webauthn.create', reg.challenge),
        label: 'Test key',
      },
    });
    expect(finished.status).toBe(201);

    const listed = await req(base, 'GET', `${A}/passkeys`, { customer: userToken });
    expect(listed.status).toBe(200);
    const passkeys = data<{ passkeys: { id: string; label: string }[] }>(listed.json).passkeys;
    expect(passkeys).toHaveLength(1);
    expect(passkeys[0]?.label).toBe('Test key');
    // The credential id and public key never leave the server.
    expect(JSON.stringify(listed.json)).not.toContain(b64u(credentialId));

    // ── sign in ──
    const beginAuth = await req(base, 'POST', `${A}/passkeys/authenticate/begin`, { body: {} });
    expect(beginAuth.status).toBe(200);
    const ch = data<{ challenge: string }>(beginAuth.json).challenge;

    const ad = authData(0x05, false);
    const cdj = clientData('webauthn.get', ch);
    const signer = createSign('SHA256');
    signer.update(
      Buffer.concat([ad, createHash('sha256').update(Buffer.from(cdj, 'base64url')).digest()]),
    );
    signer.end();
    const signature = b64u(signer.sign({ key: kp.privateKey, dsaEncoding: 'der' }));

    const loggedIn = await req(base, 'POST', `${A}/passkeys/authenticate/finish`, {
      body: {
        challenge: ch,
        credentialId: b64u(credentialId),
        authenticatorData: b64u(ad),
        clientDataJSON: cdj,
        signature,
      },
    });
    expect(loggedIn.status).toBe(200);
    const session = data<{ user: { email: string }; tokens: { accessToken: string } }>(
      loggedIn.json,
    );
    expect(session.user.email).toBe('passkey@example.com');
    expect(session.tokens.accessToken).toBeTruthy();

    // ── the challenge is spent: replaying the exact same assertion fails ──
    const replay = await req(base, 'POST', `${A}/passkeys/authenticate/finish`, {
      body: {
        challenge: ch,
        credentialId: b64u(credentialId),
        authenticatorData: b64u(ad),
        clientDataJSON: cdj,
        signature,
      },
    });
    expect(replay.status).toBe(400);

    // ── a forged signature from a different key is refused ──
    const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const beginAgain = await req(base, 'POST', `${A}/passkeys/authenticate/begin`, { body: {} });
    const ch2 = data<{ challenge: string }>(beginAgain.json).challenge;
    const cdj2 = clientData('webauthn.get', ch2);
    const forger = createSign('SHA256');
    forger.update(
      Buffer.concat([ad, createHash('sha256').update(Buffer.from(cdj2, 'base64url')).digest()]),
    );
    forger.end();
    const forged = await req(base, 'POST', `${A}/passkeys/authenticate/finish`, {
      body: {
        challenge: ch2,
        credentialId: b64u(credentialId),
        authenticatorData: b64u(ad),
        clientDataJSON: cdj2,
        signature: b64u(forger.sign({ key: other.privateKey, dsaEncoding: 'der' })),
      },
    });
    expect(forged.status).toBe(401);
  });

  it('refuses to list or delete passkeys without a session', async () => {
    const A = `/api/v1/projects/${projectA}/auth`;
    expect((await req(base, 'GET', `${A}/passkeys`)).status).toBe(401);
    expect((await req(base, 'DELETE', `${A}/passkeys/abcdef0123456789`)).status).toBe(401);
  });
});
