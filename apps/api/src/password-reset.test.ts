import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { ApiContext } from './v1.js';
import { platformAuthFor } from './platform-auth.js';
import { hashToken, newOpaqueToken } from '@cloudnivo/auth';

/**
 * Platform password reset.
 *
 * The flow's whole job is to let someone back in without letting anyone else
 * in, so the tests are mostly about what it refuses: enumeration, replay,
 * expiry, weak passwords, and sessions that outlive the reset.
 */

const JWT_SECRET = 'r'.repeat(48);
const PASSWORD = 'Reset-flow-original-1';

interface Booted {
  base: string;
  ctx: ApiContext;
  close: () => Promise<void>;
}

async function boot(): Promise<Booted> {
  process.env['NODE_ENV'] = 'test';
  process.env['DATABASE_URL'] = 'postgres://u:p@localhost:5432/db';
  process.env['JWT_SECRET'] = JWT_SECRET;
  process.env['CORS_ORIGINS'] = 'http://localhost:3000';
  process.env['CACHE_DRIVER'] = 'memory';
  process.env['CONTROL_STORE'] = 'memory';
  process.env['PROVISION_DRIVER'] = 'fake';
  process.env['AUTH_RATE_MAX'] = '1000';
  process.env['RATE_LIMIT_MAX_REQUESTS'] = '10000';
  delete process.env['PLATFORM_ADMIN_EMAILS'];
  const { start } = await import('./index.js');
  const { server, port, ctx } = await start(0);
  const srv = server as Server;
  return {
    base: `http://127.0.0.1:${port}`,
    ctx,
    close: () => new Promise((resolve, reject) => srv.close(e => (e ? reject(e) : resolve()))),
  };
}

async function api(
  base: string,
  method: string,
  path: string,
  body?: unknown,
  token?: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    json = {};
  }
  return { status: res.status, json };
}

/**
 * The raw token only ever exists in the email, which tests cannot read. So
 * mint one through the store exactly as the route does — the store contract
 * is what the route depends on, and it is what is under test here.
 */
async function issueToken(ctx: ApiContext, userId: string, ttlMs = 3_600_000): Promise<string> {
  const raw = newOpaqueToken();
  await platformAuthFor(ctx).resets.save({
    tokenHash: hashToken(raw),
    userId,
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
    consumedAt: null,
  });
  return raw;
}

let live: Booted | null = null;
afterEach(async () => {
  await live?.close();
  live = null;
});

async function signup(base: string, email: string): Promise<{ token: string; userId: string }> {
  const res = await api(base, 'POST', '/api/v1/auth/signup', { email, password: PASSWORD });
  expect(res.status).toBe(201);
  const data = res.json['data'] as { token: string; user: { id: string } };
  return { token: data.token, userId: data.user.id };
}

describe('password reset request', () => {
  it('answers identically for a known and an unknown address', async () => {
    live = await boot();
    const { base } = live;
    await signup(base, 'known@example.com');

    const known = await api(base, 'POST', '/api/v1/auth/password/forgot', {
      email: 'known@example.com',
    });
    const unknown = await api(base, 'POST', '/api/v1/auth/password/forgot', {
      email: 'nobody@example.com',
    });
    // Same status and same body: this endpoint must not be a way to find out
    // which addresses have accounts.
    expect(known.status).toBe(202);
    expect(unknown.status).toBe(202);
    expect(JSON.stringify(known.json['data'])).toBe(JSON.stringify(unknown.json['data']));
  });

  it('stores only a hash of the token', async () => {
    live = await boot();
    const { base, ctx } = live;
    const { userId } = await signup(base, 'hash@example.com');
    const raw = await issueToken(ctx, userId);
    const store = platformAuthFor(ctx).resets as unknown as {
      rows: Map<string, { tokenHash: string }>;
    };
    const stored = [...store.rows.keys()];
    expect(stored).toContain(hashToken(raw));
    expect(stored).not.toContain(raw);
  });
});

describe('password reset completion', () => {
  it('sets the new password, and the old one stops working', async () => {
    live = await boot();
    const { base, ctx } = live;
    const { userId } = await signup(base, 'rotate@example.com');
    const raw = await issueToken(ctx, userId);

    const done = await api(base, 'POST', '/api/v1/auth/password/reset', {
      token: raw,
      password: 'Reset-flow-brand-new-2',
    });
    expect(done.status).toBe(200);

    const oldWay = await api(base, 'POST', '/api/v1/auth/login', {
      email: 'rotate@example.com',
      password: PASSWORD,
    });
    expect(oldWay.status).toBe(401);
    const newWay = await api(base, 'POST', '/api/v1/auth/login', {
      email: 'rotate@example.com',
      password: 'Reset-flow-brand-new-2',
    });
    expect(newWay.status).toBe(200);
  });

  it('revokes sessions that were live before the reset', async () => {
    live = await boot();
    const { base, ctx } = live;
    const { token, userId } = await signup(base, 'sessions@example.com');
    // The session works before the reset…
    expect((await api(base, 'GET', '/api/v1/me', undefined, token)).status).toBe(200);

    const raw = await issueToken(ctx, userId);
    await api(base, 'POST', '/api/v1/auth/password/reset', {
      token: raw,
      password: 'Reset-flow-brand-new-2',
    });

    // …and not after. A reset is what you do when you think someone else is
    // in the account, so their session has to end too.
    expect((await api(base, 'GET', '/api/v1/me', undefined, token)).status).toBe(401);
  });

  it('cannot be replayed, and other outstanding tokens die with it', async () => {
    live = await boot();
    const { base, ctx } = live;
    const { userId } = await signup(base, 'replay@example.com');
    const first = await issueToken(ctx, userId);
    const second = await issueToken(ctx, userId);

    expect(
      (await api(base, 'POST', '/api/v1/auth/password/reset', {
        token: first,
        password: 'Reset-flow-brand-new-2',
      })).status,
    ).toBe(200);

    // Same token again.
    expect(
      (await api(base, 'POST', '/api/v1/auth/password/reset', {
        token: first,
        password: 'Reset-flow-third-3',
      })).status,
    ).toBe(400);
    // And the one still sitting in an older email.
    expect(
      (await api(base, 'POST', '/api/v1/auth/password/reset', {
        token: second,
        password: 'Reset-flow-third-3',
      })).status,
    ).toBe(400);
  });

  it('refuses an expired token, a forged token, and a weak password', async () => {
    live = await boot();
    const { base, ctx } = live;
    const { userId } = await signup(base, 'refuse@example.com');

    const expired = await issueToken(ctx, userId, -1000);
    expect(
      (await api(base, 'POST', '/api/v1/auth/password/reset', {
        token: expired,
        password: 'Reset-flow-brand-new-2',
      })).status,
    ).toBe(400);

    expect(
      (await api(base, 'POST', '/api/v1/auth/password/reset', {
        token: newOpaqueToken(),
        password: 'Reset-flow-brand-new-2',
      })).status,
    ).toBe(400);

    const good = await issueToken(ctx, userId);
    const weak = await api(base, 'POST', '/api/v1/auth/password/reset', {
      token: good,
      password: 'short',
    });
    expect(weak.status).toBe(400);
    expect(JSON.stringify(weak.json)).toMatch(/WEAK_PASSWORD|password/i);

    // The rejected attempt must not have spent the token.
    expect(
      (await api(base, 'POST', '/api/v1/auth/password/reset', {
        token: good,
        password: 'Reset-flow-brand-new-2',
      })).status,
    ).toBe(200);
  });
});
