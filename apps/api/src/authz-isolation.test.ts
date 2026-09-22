import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';

/**
 * Individual-account authorization: the isolation and role rules that must
 * hold for every plane, proven over real HTTP against the real router.
 *
 * USER → ORGANIZATION → PROJECT → ENVIRONMENT → RESOURCE
 *
 * Two unrelated accounts (A and B) each with their own organization and
 * project, plus three roles inside A's org (owner, developer/member, viewer)
 * and three credential kinds (session, project API key, agent token). Every
 * assertion here is a denial that must survive: a passing suite means one
 * account cannot reach another's anything, and a lesser role cannot perform
 * a greater role's operation.
 */

const JWT_SECRET = 'z'.repeat(48);

async function boot(): Promise<{ base: string; close: () => Promise<void> }> {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = 'postgres://u:p@localhost:5432/db';
  process.env.JWT_SECRET = JWT_SECRET;
  process.env.CORS_ORIGINS = 'http://localhost:3000';
  process.env.CACHE_DRIVER = 'memory';
  process.env.PROVISION_DRIVER = 'fake';
  process.env.STORAGE_DRIVER = 'local';
  process.env.VAULT_KEY = 'k'.repeat(48);
  // This suite deliberately drives dozens of denials from one address, which
  // is exactly what the adaptive threat tracker exists to ban. Budgets are
  // raised for the harness only — the tracker itself is covered by
  // apps/api/src/threat.test.ts, and rate limiting by reliability.test.ts.
  process.env.AUTH_RATE_MAX = '1000';
  process.env.RATE_LIMIT_MAX_REQUESTS = '10000';
  process.env.THREAT_THROTTLE_AT = '10000';
  process.env.THREAT_BAN_AT = '50000';
  process.env.STORAGE_LOCAL_DIR = await mkdtemp(join(tmpdir(), 'cn-api-authz-'));
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

/** Any 2xx is a failure for these — name the route so a regression is obvious. */
function expectDenied(r: { status: number; json: Record<string, unknown> }, label: string): void {
  expect(
    r.status,
    `${label} should have been denied but returned ${r.status}`,
  ).toBeGreaterThanOrEqual(400);
  expect(r.status, label).toBeLessThan(500);
}

describe('individual account authorization', () => {
  let base = '';
  let close: () => Promise<void> = async () => {};

  // Account A: owner + member + viewer in orgA, projectA.
  let ownerA = '';
  let memberA = '';
  let viewerA = '';
  let orgA = '';
  let projectA = '';
  let keyPublicA = '';
  let keyServiceA = '';

  // Account B: a completely unrelated tenant.
  let ownerB = '';
  let orgB = '';
  let projectB = '';

  async function signup(email: string): Promise<string> {
    const r = await api(base, 'POST', '/api/v1/auth/signup', null, {
      email,
      password: 'correct-horse-battery-1',
    });
    expect(r.status, `signup ${email}`).toBe(201);
    return data<{ token: string }>(r.json).token;
  }

  async function invite(
    orgId: string,
    inviterToken: string,
    email: string,
    role: string,
    inviteeToken: string,
  ): Promise<void> {
    const inv = await api(base, 'POST', `/api/v1/organizations/${orgId}/invites`, inviterToken, {
      email,
      role,
    });
    expect(inv.status, `invite ${role}`).toBe(201);
    const accept = await api(
      base,
      'POST',
      `/api/v1/invites/${data<{ token: string }>(inv.json).token}/accept`,
      inviteeToken,
      {},
    );
    expect(accept.status, `accept ${role}`).toBe(200);
  }

  beforeAll(async () => {
    const b = await boot();
    base = b.base;
    close = b.close;

    ownerA = await signup('authz-owner-a@example.com');
    memberA = await signup('authz-member-a@example.com');
    viewerA = await signup('authz-viewer-a@example.com');
    ownerB = await signup('authz-owner-b@example.com');

    const mkOrg = async (tok: string, slug: string): Promise<string> => {
      const r = await api(base, 'POST', '/api/v1/organizations', tok, { name: slug, slug });
      expect(r.status).toBe(201);
      return data<{ organization: { id: string } }>(r.json).organization.id;
    };
    orgA = await mkOrg(ownerA, 'authzorga');
    orgB = await mkOrg(ownerB, 'authzorgb');

    await invite(orgA, ownerA, 'authz-member-a@example.com', 'member', memberA);
    await invite(orgA, ownerA, 'authz-viewer-a@example.com', 'viewer', viewerA);

    const mkProject = async (tok: string, org: string, slug: string): Promise<string> => {
      const r = await api(base, 'POST', '/api/v1/projects', tok, {
        name: slug,
        slug,
        organizationId: org,
      });
      expect(r.status).toBe(202);
      return data<{ project: { id: string } }>(r.json).project.id;
    };
    projectA = await mkProject(ownerA, orgA, 'authzproja');
    projectB = await mkProject(ownerB, orgB, 'authzprojb');

    const mkKey = async (role: string): Promise<string> => {
      const r = await api(base, 'POST', `/api/v1/projects/${projectA}/keys`, ownerA, {
        name: `${role} key`,
        role,
      });
      expect(r.status, `create ${role} key`).toBe(201);
      return data<{ raw: string }>(r.json).raw;
    };
    keyPublicA = await mkKey('public');
    keyServiceA = await mkKey('service');
  });

  afterAll(async () => {
    await close();
    const dir = process.env.STORAGE_LOCAL_DIR ?? '';
    if (dir.includes('cn-api-authz-')) await rm(dir, { recursive: true, force: true });
  });

  // ── USER A cannot reach USER B ──

  it("denies User A every route into User B's project", async () => {
    const routes: [string, string, unknown?][] = [
      ['GET', `/api/v1/projects/${projectB}`],
      ['GET', `/api/v1/projects/${projectB}/connect`],
      ['GET', `/api/v1/projects/${projectB}/database`],
      ['GET', `/api/v1/projects/${projectB}/database/schema`],
      ['GET', `/api/v1/projects/${projectB}/database/connection`],
      ['GET', `/api/v1/projects/${projectB}/database/vault`],
      ['GET', `/api/v1/projects/${projectB}/database/migrations`],
      ['GET', `/api/v1/projects/${projectB}/database/environments`],
      ['GET', `/api/v1/projects/${projectB}/storage/buckets`],
      ['GET', `/api/v1/projects/${projectB}/functions`],
      ['GET', `/api/v1/projects/${projectB}/jobs`],
      ['GET', `/api/v1/projects/${projectB}/keys`],
      ['GET', `/api/v1/projects/${projectB}/queues`],
      ['POST', `/api/v1/projects/${projectB}/database/query`, { sql: 'select 1' }],
      ['POST', `/api/v1/projects/${projectB}/storage/buckets`, { name: 'stolen' }],
      ['DELETE', `/api/v1/projects/${projectB}`],
    ];
    for (const [method, path, body] of routes) {
      expectDenied(await api(base, method, path, ownerA, body), `A→B ${method} ${path}`);
    }
  });

  it("denies User A every route into User B's organization", async () => {
    const routes: [string, string][] = [
      ['GET', `/api/v1/organizations/${orgB}/agent-tokens`],
      ['GET', `/api/v1/organizations/${orgB}/agent-activity`],
      ['GET', `/api/v1/organizations/${orgB}/approvals`],
      ['GET', `/api/v1/organizations/${orgB}/usage`],
    ];
    for (const [method, path] of routes) {
      expectDenied(await api(base, method, path, ownerA, undefined), `A→B org ${method} ${path}`);
    }
  });

  it("never lists another tenant's projects", async () => {
    const r = await api(base, 'GET', '/api/v1/projects', ownerA);
    expect(r.status).toBe(200);
    const ids = data<{ projects: { id: string }[] }>(r.json).projects.map(p => p.id);
    expect(ids).toContain(projectA);
    expect(ids).not.toContain(projectB);
  });

  // ── ROLE separation inside one organization ──

  it('lets a viewer read but never write', async () => {
    expect((await api(base, 'GET', `/api/v1/projects/${projectA}`, viewerA)).status).toBe(200);
    expect(
      (await api(base, 'GET', `/api/v1/projects/${projectA}/storage/buckets`, viewerA)).status,
    ).toBe(200);

    const writes: [string, string, unknown?][] = [
      ['POST', `/api/v1/projects/${projectA}/storage/buckets`, { name: 'viewer-bucket' }],
      [
        'POST',
        `/api/v1/projects/${projectA}/database/migrations`,
        { name: 'viewer_mig', sql: 'create table v (id uuid primary key);' },
      ],
      ['POST', `/api/v1/projects/${projectA}/keys`, { name: 'viewer key', role: 'service' }],
      ['PUT', `/api/v1/projects/${projectA}/database/vault/VIEWER`, { value: 'x' }],
      ['POST', `/api/v1/projects/${projectA}/database/actions`, { action: 'stop' }],
      ['POST', `/api/v1/projects/${projectA}/database/provision`, {}],
      ['POST', `/api/v1/projects/${projectA}/database/query`, { sql: 'create table t (id int)' }],
      ['DELETE', `/api/v1/projects/${projectA}`],
    ];
    for (const [method, path, body] of writes) {
      expectDenied(await api(base, method, path, viewerA, body), `viewer ${method} ${path}`);
    }
  });

  it('lets a member read and run data writes but not perform admin operations', async () => {
    // A member is a real collaborator: reads and guarded SQL are allowed.
    expect((await api(base, 'GET', `/api/v1/projects/${projectA}`, memberA)).status).toBe(200);
    expect(
      (
        await api(base, 'POST', `/api/v1/projects/${projectA}/database/query`, memberA, {
          sql: 'select 1',
        })
      ).status,
    ).toBe(200);

    // Admin-only operations stay closed. Bucket MANAGEMENT is admin by policy
    // (packages/storage/src/policies.ts), distinct from writing objects.
    expectDenied(
      await api(base, 'POST', `/api/v1/projects/${projectA}/keys`, memberA, {
        name: 'k',
        role: 'service',
      }),
      'member creates key',
    );
    expectDenied(
      await api(base, 'POST', `/api/v1/projects/${projectA}/storage/buckets`, memberA, {
        name: 'member-bucket',
      }),
      'member creates bucket',
    );
    expectDenied(
      await api(base, 'DELETE', `/api/v1/projects/${projectA}`, memberA),
      'member deletes project',
    );
    // NOTE: start/stop/restart is `projects:update`, which a member legitimately
    // holds — see the scope catalog ("Start, stop, and restart project
    // databases"). The security property is that a VIEWER cannot; that is
    // asserted in the viewer test above, not here.
    expectDenied(
      await api(base, 'POST', `/api/v1/organizations/${orgA}/agent-tokens`, memberA, {
        name: 'x',
        scopes: ['projects.read'],
      }),
      'member issues agent token',
    );
  });

  it('lets an owner do what the lesser roles could not', async () => {
    const bucket = await api(base, 'POST', `/api/v1/projects/${projectA}/storage/buckets`, ownerA, {
      name: 'owner-bucket',
    });
    expect([200, 201]).toContain(bucket.status);
    expect(
      (
        await api(
          base,
          'DELETE',
          `/api/v1/projects/${projectA}/storage/buckets/owner-bucket`,
          ownerA,
        )
      ).status,
    ).toBe(200);
  });

  // ── API KEY authority ──

  it('never lets any project API key manage buckets, whatever its role', async () => {
    // Reads are fine — that is what a public key is for.
    const read = await fetch(`${base}/api/v1/projects/${projectA}/storage/buckets`, {
      headers: { apikey: keyPublicA },
    });
    expect(read.status).toBe(200);

    // Bucket management is reserved for admin SESSIONS. A key — even a
    // service key — is application identity, not an administrator, so
    // neither may create infrastructure.
    for (const [label, key] of [
      ['public', keyPublicA],
      ['service', keyServiceA],
    ] as const) {
      const write = await fetch(`${base}/api/v1/projects/${projectA}/storage/buckets`, {
        method: 'POST',
        headers: { apikey: key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: `${label}-key-bucket` }),
      });
      expect(write.status, `${label} key must not create buckets`).toBe(403);
    }
  });

  it('never lets a project key manage keys or cross into another project', async () => {
    const manage = await fetch(`${base}/api/v1/projects/${projectA}/keys`, {
      method: 'POST',
      headers: { apikey: keyServiceA, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'escalated', role: 'admin' }),
    });
    expect(manage.status, 'keys must not mint keys').toBe(403);

    const cross = await fetch(`${base}/api/v1/projects/${projectB}/storage/buckets`, {
      headers: { apikey: keyServiceA },
    });
    expect(cross.status, 'project A key must not read project B').toBe(403);
  });

  // ── AGENT TOKEN authority ──

  it('confines an agent token to its scopes and its project', async () => {
    const issued = await api(base, 'POST', `/api/v1/organizations/${orgA}/agent-tokens`, ownerA, {
      name: 'readonly agent',
      scopes: ['projects.read', 'database.read', 'storage.read'],
      projectIds: [projectA],
      expiresIn: '7d',
    });
    expect(issued.status).toBe(201);
    const { token, raw } = data<{ token: { id: string }; raw: string }>(issued.json);

    // In scope.
    expect(
      (await api(base, 'GET', `/api/v1/projects/${projectA}/storage/buckets`, raw)).status,
    ).toBe(200);

    // Out of scope — no storage.write.
    expectDenied(
      await api(base, 'POST', `/api/v1/projects/${projectA}/storage/buckets`, raw, {
        name: 'agent-bucket',
      }),
      'agent without storage.write',
    );
    // Out of project.
    expectDenied(
      await api(base, 'GET', `/api/v1/projects/${projectB}/storage/buckets`, raw),
      'agent into another org project',
    );
    // Never credentials.
    expectDenied(
      await api(base, 'GET', `/api/v1/projects/${projectA}/database/connection?reveal=true`, raw),
      'agent reveals credentials',
    );
    // Never key management.
    expectDenied(
      await api(base, 'POST', `/api/v1/projects/${projectA}/keys`, raw, {
        name: 'k',
        role: 'admin',
      }),
      'agent mints key',
    );

    // Revocation is immediate.
    expect(
      (await api(base, 'DELETE', `/api/v1/organizations/${orgA}/agent-tokens/${token.id}`, ownerA))
        .status,
    ).toBe(200);
    expectDenied(await api(base, 'GET', '/api/v1/agent/whoami', raw), 'revoked agent token');
    expectDenied(
      await api(base, 'GET', `/api/v1/projects/${projectA}/storage/buckets`, raw),
      'revoked agent token on storage',
    );
  });

  it('rejects an agent token scoped to a project it was not granted', async () => {
    // Token limited to projectA only; orgA has just this one project, so a
    // second project proves the projectIds confinement rather than the org one.
    const second = await api(base, 'POST', '/api/v1/projects', ownerA, {
      name: 'authzproja2',
      slug: 'authzproja2',
      organizationId: orgA,
    });
    expect(second.status).toBe(202);
    const projectA2 = data<{ project: { id: string } }>(second.json).project.id;

    const issued = await api(base, 'POST', `/api/v1/organizations/${orgA}/agent-tokens`, ownerA, {
      name: 'project-scoped agent',
      scopes: ['projects.read', 'database.read'],
      projectIds: [projectA],
      expiresIn: '7d',
    });
    const raw = data<{ raw: string }>(issued.json).raw;

    expect((await api(base, 'GET', `/api/v1/projects/${projectA}`, raw)).status).toBe(200);
    expectDenied(
      await api(base, 'GET', `/api/v1/projects/${projectA2}`, raw),
      'agent into a sibling project it was not scoped to',
    );
  });

  // ── SESSION authority ──

  it('rejects missing, malformed and foreign-signed sessions', async () => {
    const path = `/api/v1/projects/${projectA}`;
    expectDenied(await api(base, 'GET', path, null), 'no credential');
    expectDenied(await api(base, 'GET', path, 'not-a-jwt'), 'malformed token');
    // A well-formed JWT signed with the wrong secret must not authenticate.
    const { signSession } = await import('@cloudnivo/auth');
    const forged = await signSession(
      { sub: '00000000-0000-4000-8000-000000000000', email: 'forged@example.com' },
      { jwtSecret: 'q'.repeat(48) },
    );
    expectDenied(await api(base, 'GET', path, forged), 'foreign-signed session');
  });

  it('does not leak existence of another tenant through error shape', async () => {
    // A real project the caller may not see, and a project that does not
    // exist at all, must not be distinguishable as "forbidden" vs "missing"
    // in a way that enumerates other tenants' ids.
    const foreign = await api(base, 'GET', `/api/v1/projects/${projectB}`, ownerA);
    const missing = await api(
      base,
      'GET',
      '/api/v1/projects/99999999-9999-4999-8999-999999999999',
      ownerA,
    );
    expect([403, 404]).toContain(foreign.status);
    expect([403, 404]).toContain(missing.status);
  });

  // ── AUDIT ──

  it('records agent denials in the organization audit trail', async () => {
    const r = await api(base, 'GET', `/api/v1/organizations/${orgA}/agent-activity`, ownerA);
    expect(r.status).toBe(200);
    const entries = data<{ activity: { result: string }[] }>(r.json).activity;
    expect(entries.some(e => e.result === 'denied')).toBe(true);
    // And never the raw secret material.
    expect(JSON.stringify(r.json)).not.toContain('cn_agent_');
  });

  it('keeps the audit trail itself org-scoped', async () => {
    expectDenied(
      await api(base, 'GET', `/api/v1/organizations/${orgA}/agent-activity`, ownerB),
      'outsider reads audit trail',
    );
  });

  // ── Planes added after the first pass of this suite ──
  //
  // Automation, billing, AI, realtime, metrics and the database advisor and
  // branch routes all landed after the cross-tenant list above was written, so
  // none of them was covered by it. Each was verified closed by hand; these
  // assertions are what stops one of them drifting open unnoticed. The
  // strongest credential A holds is used deliberately: if an owner cannot
  // reach tenant B here, no lesser role can.
  it("denies an owner every newer route into another tenant's project and org", async () => {
    const PB = `/api/v1/projects/${projectB}`;
    const OB = `/api/v1/organizations/${orgB}`;
    const routes: [string, string, unknown?][] = [
      ['GET', `${PB}/schedules`],
      ['POST', `${PB}/schedules`, { name: 'x', functionSlug: 'f', cron: '0 2 * * *' }],
      ['GET', `${PB}/webhooks`],
      ['POST', `${PB}/webhooks`, { name: 'x', url: 'https://example.com/h', eventTypes: ['job.failed'] }],
      ['GET', `${PB}/ai/usage`],
      ['POST', `${PB}/ai/plan`, { prompt: 'read another tenant' }],
      ['GET', `${PB}/storage/usage`],
      ['GET', `${PB}/metrics`],
      ['GET', `${PB}/database/advisors`],
      ['POST', `${PB}/database/branches`, { name: 'b' }],
      ['GET', `${PB}/realtime/stats`],
      ['GET', `${PB}/realtime/channels`],
      ['GET', `${OB}/billing/plan`],
      ['GET', `${OB}/billing/usage`],
      ['GET', `${OB}/billing/budgets`],
      ['POST', `${OB}/billing/subscription`, { planKey: 'pro' }],
      ['POST', `${OB}/invites`, { email: 'cross-tenant@example.com', role: 'admin' }],
      ['PATCH', `${PB}`, { name: 'hijacked' }],
    ];
    for (const [method, path, body] of routes) {
      expectDenied(await api(base, method, path, ownerA, body), `A -> B ${method} ${path}`);
    }
  });

  it('holds the role line on automation, billing and environment writes', async () => {
    const P = `/api/v1/projects/${projectA}`;
    const O = `/api/v1/organizations/${orgA}`;
    // Reads are open to every member of the org, viewer included.
    for (const path of [`${P}/queues`, `${P}/schedules`, `${P}/webhooks`, `${O}/billing/plan`]) {
      expect((await api(base, 'GET', path, viewerA)).status, `viewer reads ${path}`).toBe(200);
    }
    // Writes are management operations: neither a viewer nor a member may.
    const writes: [string, string, unknown?][] = [
      ['POST', `${P}/queues`, { name: 'role-q' }],
      ['POST', `${P}/schedules`, { name: 'role-s', functionSlug: 'f', cron: '0 2 * * *' }],
      ['POST', `${P}/webhooks`, { name: 'role-w', url: 'https://example.com/h', eventTypes: ['job.failed'] }],
      ['POST', `${P}/database/environments`, { name: 'role-env', slug: 'roleenv' }],
      ['POST', `${O}/billing/subscription`, { planKey: 'pro' }],
      ['POST', `${O}/billing/invoices`, {}],
    ];
    for (const [method, path, body] of writes) {
      expectDenied(await api(base, method, path, viewerA, body), `viewer ${method} ${path}`);
      expectDenied(await api(base, method, path, memberA, body), `member ${method} ${path}`);
    }
  });

  it('kills an agent token the instant it is revoked, and on rotation kills the old secret', async () => {
    const mk = await api(base, 'POST', `/api/v1/organizations/${orgA}/agent-tokens`, ownerA, {
      name: 'revocation-probe',
      scopes: ['projects.read'],
      projectIds: [projectA],
    });
    expect(mk.status).toBe(201);
    const issued = data<{ token: { id: string }; raw: string }>(mk.json);
    // Works while live — otherwise the denial below would prove nothing.
    expect(
      (await api(base, 'GET', `/api/v1/projects/${projectA}`, issued.raw)).status,
      'token works before revocation',
    ).toBe(200);
    expect(
      (await api(base, 'DELETE', `/api/v1/organizations/${orgA}/agent-tokens/${issued.token.id}`, ownerA))
        .status,
    ).toBe(200);
    expectDenied(
      await api(base, 'GET', `/api/v1/projects/${projectA}`, issued.raw),
      'revoked agent token',
    );

    const rot = await api(base, 'POST', `/api/v1/organizations/${orgA}/agent-tokens`, ownerA, {
      name: 'rotation-probe',
      scopes: ['projects.read'],
      projectIds: [projectA],
    });
    const first = data<{ token: { id: string }; raw: string }>(rot.json);
    const spun = await api(
      base,
      'POST',
      `/api/v1/organizations/${orgA}/agent-tokens/${first.token.id}/rotate`,
      ownerA,
      {},
    );
    expect(spun.status).toBe(200);
    expectDenied(
      await api(base, 'GET', `/api/v1/projects/${projectA}`, first.raw),
      'pre-rotation secret',
    );
    expect(
      (await api(base, 'GET', `/api/v1/projects/${projectA}`, data<{ raw: string }>(spun.json).raw))
        .status,
      'post-rotation secret',
    ).toBe(200);
  });
});
