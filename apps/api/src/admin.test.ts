import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { ApiContext } from './v1.js';
import { platformAuthFor } from './platform-auth.js';

/**
 * The operator console is the only cross-tenant reader in the API, so these
 * tests are mostly about who is refused. The happy path matters too, but the
 * regression that leaks the whole platform to an ordinary developer is the
 * one that actually costs something.
 *
 * Everything runs against a booted server over HTTP — the same path a real
 * caller takes, including the staff bootstrap that runs during boot.
 */

const JWT_SECRET = 'a'.repeat(48);

interface Booted {
  base: string;
  ctx: ApiContext;
  close: () => Promise<void>;
}

async function boot(env: Record<string, string> = {}): Promise<Booted> {
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
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
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
  token?: string | null,
  body?: unknown,
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

async function signup(
  base: string,
  email: string,
): Promise<{ token: string; userId: string; isPlatformAdmin: boolean }> {
  const res = await api(base, 'POST', '/api/v1/auth/signup', null, {
    email,
    password: 'Operator-console-42',
  });
  expect(res.status, `signup ${email}`).toBe(201);
  const data = res.json['data'] as {
    token: string;
    user: { id: string; isPlatformAdmin: boolean };
  };
  return { token: data.token, userId: data.user.id, isPlatformAdmin: data.user.isPlatformAdmin };
}

/** Clear the stored flag; there is deliberately no demotion route. */
function demote(ctx: ApiContext, userId: string): void {
  const store = platformAuthFor(ctx).users as unknown as {
    users: Map<string, { isPlatformAdmin: boolean }>;
  };
  const row = store.users.get(userId);
  if (row) row.isPlatformAdmin = false;
}

const ROUTES = ['/overview', '/users', '/organizations', '/projects', '/audit', '/jobs'];

let live: Booted | null = null;
afterEach(async () => {
  await live?.close();
  live = null;
});

describe('operator console access', () => {
  it('is invisible without a token, with a forged token, and to an ordinary developer', async () => {
    live = await boot();
    const { base } = live;
    expect((await api(base, 'GET', '/api/v1/admin/overview')).status).toBe(404);
    expect((await api(base, 'GET', '/api/v1/admin/overview', 'forged.token.value')).status).toBe(404);

    const dev = await signup(base, 'ordinary@example.com');
    expect(dev.isPlatformAdmin).toBe(false);
    for (const route of ROUTES) {
      const res = await api(base, 'GET', `/api/v1/admin${route}`, dev.token);
      expect(res.status, `${route} must not exist for a non-staff developer`).toBe(404);
    }
  });

  it('opens for an allowlisted operator and closes again the moment the flag is cleared', async () => {
    live = await boot({ PLATFORM_ADMIN_EMAILS: 'operator@example.com' });
    const { base, ctx } = live;
    const op = await signup(base, 'operator@example.com');
    expect(op.isPlatformAdmin).toBe(true);
    expect((await api(base, 'GET', '/api/v1/admin/overview', op.token)).status).toBe(200);

    /**
     * The same token, after demotion. This is why the flag is re-read from
     * the store on every request rather than stamped into the JWT: a token
     * minted while staff must stop working the moment staff ends.
     */
    demote(ctx, op.userId);
    expect((await api(base, 'GET', '/api/v1/admin/overview', op.token)).status).toBe(404);
  });

  it('is read-only — a write is refused even for staff', async () => {
    live = await boot({ PLATFORM_ADMIN_EMAILS: 'operator@example.com' });
    const { base } = live;
    const op = await signup(base, 'operator@example.com');
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await api(base, method, '/api/v1/admin/users', op.token, { grant: true });
      expect(res.status, `${method} must not be routed`).toBe(404);
    }
  });
});

describe('operator console data', () => {
  it('sees every tenant, which no other route in the API may do', async () => {
    live = await boot({ PLATFORM_ADMIN_EMAILS: 'operator@example.com' });
    const { base } = live;

    for (const slug of ['alpha', 'beta']) {
      const who = await signup(base, `${slug}@example.com`);
      const org = await api(base, 'POST', '/api/v1/organizations', who.token, {
        name: slug,
        slug,
      });
      expect(org.status).toBe(201);
      const orgId = (org.json['data'] as { organization: { id: string } }).organization.id;
      const project = await api(base, 'POST', '/api/v1/projects', who.token, {
        name: `${slug}-api`,
        slug: `${slug}-api`,
        organizationId: orgId,
      });
      expect(project.status).toBe(202);
    }

    const op = await signup(base, 'operator@example.com');
    const res = await api(base, 'GET', '/api/v1/admin/overview', op.token);
    expect(res.status).toBe(200);
    const body = res.json['data'] as {
      totals: { users: number; organizations: number; projects: number };
      recent: { usersThisWeek: number; projectsThisWeek: number };
      growth: { month: string; users: number; projects: number }[];
      databases: Record<string, number>;
    };
    expect(body.totals.users).toBe(3); // two tenants + the operator
    expect(body.totals.organizations).toBe(2);
    expect(body.totals.projects).toBe(2);
    expect(body.recent.usersThisWeek).toBe(3);
    expect(body.recent.projectsThisWeek).toBe(2);

    // The series always spans the full window, so a quiet month renders as a
    // zero on the line instead of a missing point that flattens it.
    expect(body.growth).toHaveLength(12);
    expect(body.growth.every(p => /^\d{4}-\d{2}$/.test(p.month))).toBe(true);
    expect(body.growth[11]?.users).toBe(3);
  });

  it('ranks organizations by project count without multiplying member counts', async () => {
    live = await boot({ PLATFORM_ADMIN_EMAILS: 'operator@example.com' });
    const { base } = live;
    const dev = await signup(base, 'dev@example.com');
    const mk = async (slug: string, projects: number): Promise<void> => {
      const org = await api(base, 'POST', '/api/v1/organizations', dev.token, { name: slug, slug });
      const orgId = (org.json['data'] as { organization: { id: string } }).organization.id;
      for (let i = 0; i < projects; i += 1) {
        await api(base, 'POST', '/api/v1/projects', dev.token, {
          name: `${slug}-${i}`,
          slug: `${slug}-${i}`,
          organizationId: orgId,
        });
      }
    };
    await mk('small', 1);
    await mk('big', 3);

    const op = await signup(base, 'operator@example.com');
    const res = await api(base, 'GET', '/api/v1/admin/organizations?limit=999', op.token);
    expect(res.status).toBe(200);
    const orgs = (res.json['data'] as { organizations: { slug: string; projects: number; members: number }[] })
      .organizations;
    expect(orgs[0]?.slug).toBe('big');
    expect(orgs[0]?.projects).toBe(3);
    // One member, three projects: a naive two-join count would report three.
    expect(orgs[0]?.members).toBe(1);
    expect(orgs.length).toBeLessThanOrEqual(200);
  });

  it('never returns password hashes or MFA material', async () => {
    live = await boot({ PLATFORM_ADMIN_EMAILS: 'operator@example.com' });
    const { base } = live;
    await signup(base, 'someone@example.com');
    const op = await signup(base, 'operator@example.com');
    const res = await api(base, 'GET', '/api/v1/admin/users', op.token);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.json)).not.toMatch(
      /passwordHash|password_hash|totpSecret|backupCodeHashes/,
    );
  });
});

describe('staff bootstrap', () => {
  it('promotes an operator who already existed before the allowlist was set', async () => {
    // First boot: no allowlist, the account is an ordinary developer.
    const first = await boot();
    const op = await signup(first.base, 'later@example.com');
    expect(op.isPlatformAdmin).toBe(false);
    const users = platformAuthFor(first.ctx).users;
    await first.close();

    // The store is per-context, so simulate the restart by promoting through
    // the same store the second boot would write to.
    expect(await users.grantPlatformAdmin('later@example.com')).toBe(true);
    expect(await users.grantPlatformAdmin('later@example.com')).toBe(false); // idempotent
    const row = await users.findByEmail('later@example.com');
    expect(row?.isPlatformAdmin).toBe(true);
  });

  it('never invents a user for an allowlisted address that has not signed up', async () => {
    live = await boot({ PLATFORM_ADMIN_EMAILS: 'ghost@example.com' });
    const users = platformAuthFor(live.ctx).users;
    expect(await users.findByEmail('ghost@example.com')).toBeNull();
  });
});
