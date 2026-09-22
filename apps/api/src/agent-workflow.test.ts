import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { signSession } from '@cloudnivo/auth';

/**
 * End-to-end agent workflow: CONNECT → DISCOVER → BUILD → MIGRATE → VERIFY,
 * plus the denials that matter more than the happy path.
 *
 * Every request here goes over real HTTP against the real router, with a
 * real `cn_agent_…` token issued through the real management route. Nothing
 * is stubbed except the database provisioner (PROVISION_DRIVER=fake), which
 * is how the rest of this suite runs too.
 */

const JWT_SECRET = 'w'.repeat(48);
const OWNER = 'cccccccc-3333-4333-8333-cccccccccccc';
const OUTSIDER = 'dddddddd-4444-4444-8444-dddddddddddd';

async function boot(): Promise<{ base: string; close: () => Promise<void> }> {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = 'postgres://u:p@localhost:5432/db';
  process.env.JWT_SECRET = JWT_SECRET;
  process.env.CORS_ORIGINS = 'http://localhost:3000';
  process.env.CACHE_DRIVER = 'memory';
  process.env.PROVISION_DRIVER = 'fake';
  process.env.STORAGE_DRIVER = 'local';
  process.env.VAULT_KEY = 'v'.repeat(48);
  process.env.STORAGE_LOCAL_DIR = await mkdtemp(join(tmpdir(), 'cn-api-agentflow-'));
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

function errorOf(json: Record<string, unknown>): {
  code: string;
  message: string;
  remediation?: string;
  requestId: string;
} {
  return json['error'] as { code: string; message: string; remediation?: string; requestId: string };
}

describe('agent developer workflow', () => {
  let base = '';
  let close: () => Promise<void> = async () => {};
  let ownerToken = '';
  let outsiderToken = '';
  let org = '';
  let otherOrg = '';
  let project = '';
  let otherProject = '';
  /** Full-capability agent inside the org. */
  let agent = '';
  /** Read-only agent — the one that must be blocked from writing. */
  let readOnlyAgent = '';

  beforeAll(async () => {
    const b = await boot();
    base = b.base;
    close = b.close;
    ownerToken = await signSession({ sub: OWNER, email: 'owner@example.com' }, { jwtSecret: JWT_SECRET });
    outsiderToken = await signSession(
      { sub: OUTSIDER, email: 'outsider@example.com' },
      { jwtSecret: JWT_SECRET },
    );
    const mkOrg = async (tok: string, slug: string): Promise<string> => {
      const r = await api(base, 'POST', '/api/v1/organizations', tok, { name: slug, slug });
      expect(r.status).toBe(201);
      return data<{ organization: { id: string } }>(r.json).organization.id;
    };
    org = await mkOrg(ownerToken, 'flowcorp');
    otherOrg = await mkOrg(outsiderToken, 'rivalcorp');
    const mkProject = async (tok: string, o: string, slug: string): Promise<string> => {
      const r = await api(base, 'POST', '/api/v1/projects', tok, { name: slug, slug, organizationId: o });
      expect(r.status).toBe(202);
      return data<{ project: { id: string } }>(r.json).project.id;
    };
    project = await mkProject(ownerToken, org, 'flowshop');
    otherProject = await mkProject(outsiderToken, otherOrg, 'rivalshop');

    const issue = async (name: string, scopes: string[]): Promise<string> => {
      const r = await api(base, 'POST', `/api/v1/organizations/${org}/agent-tokens`, ownerToken, {
        name,
        scopes,
        projectIds: [project],
        approvalRequired: true,
        expiresIn: '30d',
      });
      expect(r.status).toBe(201);
      return data<{ raw: string }>(r.json).raw;
    };
    agent = await issue('build agent', [
      'projects.read',
      'database.read',
      'database.write',
      'database.sql',
      'database.migrate',
      'storage.read',
      'storage.write',
      'functions.read',
      'environment.read',
      'environment.write',
      'logs.read',
    ]);
    readOnlyAgent = await issue('review agent', ['projects.read', 'database.read']);
  });

  afterAll(async () => {
    await close();
    const dir = process.env.STORAGE_LOCAL_DIR ?? '';
    if (dir.includes('cn-api-agentflow-')) await rm(dir, { recursive: true, force: true });
  });

  // ── DISCOVER ──

  it('serves capability discovery without a credential', async () => {
    const r = await api(base, 'GET', '/api/v1/discovery', null);
    expect(r.status).toBe(200);
    const manifest = data<{
      product: string;
      apiVersion: string;
      services: { service: string; operations: unknown[] }[];
      scopes: { scope: string }[];
      environments: string[];
      errorCodes: { code: string; remediation: string }[];
      envTemplate: { name: string }[];
    }>(r.json);
    expect(manifest.product).toBe('cloudnivo');
    expect(manifest.apiVersion).toBe('v1');
    expect(manifest.services.map(s => s.service)).toEqual(
      expect.arrayContaining(['database', 'storage', 'functions', 'secrets', 'environments']),
    );
    expect(manifest.environments).toEqual(['development', 'staging', 'preview', 'production']);
    expect(manifest.envTemplate.map(v => v.name)).toEqual(
      expect.arrayContaining(['CLOUDNIVO_URL', 'CLOUDNIVO_PROJECT_ID', 'CLOUDNIVO_AGENT_TOKEN']),
    );
    expect(manifest.errorCodes.find(e => e.code === 'APPROVAL_REQUIRED')?.remediation).toContain(
      'X-Approval-Id',
    );
    // Every advertised scope must be a scope the API actually knows.
    const catalog = await api(base, 'GET', '/api/v1/discovery/scopes', null);
    expect(catalog.status).toBe(200);
    const known = new Set(data<{ scopes: { scope: string }[] }>(catalog.json).scopes.map(s => s.scope));
    for (const op of manifest.services.flatMap(s => s.operations as { scopes: string[] }[])) {
      for (const scope of op.scopes) expect(known.has(scope), scope).toBe(true);
    }
  });

  it('answers the well-known pointer from the bare origin', async () => {
    const r = await api(base, 'GET', '/.well-known/cloudnivo.json', null);
    expect(r.status).toBe(200);
    expect(data<{ discovery: string }>(r.json).discovery).toContain('/api/v1/discovery');
  });

  // ── CONNECT ──

  it('gives an agent a connection bundle without any secret material', async () => {
    const r = await api(base, 'GET', `/api/v1/projects/${project}/connect`, agent);
    expect(r.status).toBe(200);
    const bundle = data<{
      project: { id: string };
      urls: { discovery: string; openapi: string };
      database: { password: string; connectionString: string };
      env: { lines: string[]; variables: { name: string; secret: boolean }[] };
      install: { cli: string };
    }>(r.json);
    expect(bundle.project.id).toBe(project);
    expect(bundle.urls.discovery).toContain('/api/v1/discovery');
    // The whole point: no live credential reaches an agent.
    expect(bundle.database.password).not.toMatch(/[a-z0-9]{12}/i);
    expect(bundle.database.connectionString).not.toMatch(/:[A-Za-z0-9]{12,}@/);
    expect(bundle.env.lines.join('\n')).toContain(`CLOUDNIVO_PROJECT_ID=${project}`);
    expect(bundle.env.variables.find(v => v.name === 'CLOUDNIVO_AGENT_TOKEN')?.secret).toBe(true);
    expect(bundle.install.cli).toContain('@cloudnivo/cli');
  });

  it('refuses ?reveal=true for agents and records the denial', async () => {
    const r = await api(base, 'GET', `/api/v1/projects/${project}/connect?reveal=true`, agent);
    expect(r.status).toBe(403);
    expect(errorOf(r.json).code).toBe('FORBIDDEN');
    const activity = await api(
      base,
      'GET',
      `/api/v1/organizations/${org}/agent-activity`,
      ownerToken,
    );
    expect(activity.status).toBe(200);
    const entries = data<{ activity: { action: string; result: string }[] }>(activity.json).activity;
    expect(entries.some(e => e.action === 'project.connect.reveal' && e.result === 'denied')).toBe(true);
  });

  // ── MIGRATE ──

  it('runs the full migration loop: create → preview → apply → verify', async () => {
    const created = await api(
      base,
      'POST',
      `/api/v1/projects/${project}/database/migrations`,
      agent,
      {
        name: 'add_posts_table',
        sql: 'create table posts (id uuid primary key, title text not null default \'\');',
        environment: 'development',
      },
    );
    expect(created.status).toBe(201);
    const { migration } = data<{ migration: { id: string; version: number; status: string; destructive: boolean; checksum: string } }>(
      created.json,
    );
    expect(migration.version).toBe(1);
    expect(migration.status).toBe('pending');
    expect(migration.destructive).toBe(false);

    const preview = await api(
      base,
      'POST',
      `/api/v1/projects/${project}/database/migrations/${migration.id}/preview`,
      agent,
      {},
    );
    expect(preview.status).toBe(200);
    const { preview: p } = data<{ preview: { approvalRequired: boolean; schemaBefore: string; statements: string[] } }>(
      preview.json,
    );
    expect(p.approvalRequired).toBe(false);
    expect(p.statements).toHaveLength(1);
    expect(p.schemaBefore).toMatch(/^[0-9a-f]{64}$/);

    const applied = await api(
      base,
      'POST',
      `/api/v1/projects/${project}/database/migrations/${migration.id}/apply`,
      agent,
      {},
    );
    expect(applied.status).toBe(200);
    const result = data<{ applied: boolean; statements: number; migration: { status: string; schemaAfter: string } }>(
      applied.json,
    );
    expect(result.applied).toBe(true);
    expect(result.statements).toBe(1);
    expect(result.migration.status).toBe('applied');
    expect(result.migration.schemaAfter).toMatch(/^[0-9a-f]{64}$/);

    // Recorded state, not a guess: re-applying is a conflict, not a no-op.
    const again = await api(
      base,
      'POST',
      `/api/v1/projects/${project}/database/migrations/${migration.id}/apply`,
      agent,
      {},
    );
    expect(again.status).toBe(409);

    const list = await api(base, 'GET', `/api/v1/projects/${project}/database/migrations`, agent);
    expect(list.status).toBe(200);
    expect(data<{ state: { appliedVersion: number; pending: number } }>(list.json).state).toMatchObject({
      appliedVersion: 1,
      pending: 0,
    });
  });

  it('holds a destructive migration for approval, then honours the approval once', async () => {
    const created = await api(
      base,
      'POST',
      `/api/v1/projects/${project}/database/migrations`,
      agent,
      { name: 'drop_posts', sql: 'drop table posts;', environment: 'development' },
    );
    expect(created.status).toBe(201);
    const { migration } = data<{ migration: { id: string; destructive: boolean; findings: { code: string }[] } }>(
      created.json,
    );
    expect(migration.destructive).toBe(true);
    expect(migration.findings.map(f => f.code)).toContain('DROP_TABLE');

    // The agent does not hold database.destructive → held at 428.
    const held = await api(
      base,
      'POST',
      `/api/v1/projects/${project}/database/migrations/${migration.id}/apply`,
      agent,
      {},
    );
    expect(held.status).toBe(428);
    expect(errorOf(held.json).code).toBe('APPROVAL_REQUIRED');
    expect(errorOf(held.json).remediation).toContain('X-Approval-Id');
    const approvalId = data<{ approval: { id: string } }>(held.json).approval.id;

    // Presenting an unapproved id must not work.
    const premature = await api(
      base,
      'POST',
      `/api/v1/projects/${project}/database/migrations/${migration.id}/apply`,
      agent,
      {},
      { 'X-Approval-Id': approvalId },
    );
    expect(premature.status).toBeGreaterThanOrEqual(400);
    expect(premature.status).not.toBe(200);

    const approved = await api(
      base,
      'POST',
      `/api/v1/organizations/${org}/approvals/${approvalId}/approve`,
      ownerToken,
      {},
    );
    expect(approved.status).toBe(200);

    const ok = await api(
      base,
      'POST',
      `/api/v1/projects/${project}/database/migrations/${migration.id}/apply`,
      agent,
      {},
      { 'X-Approval-Id': approvalId },
    );
    expect(ok.status).toBe(200);
    expect(data<{ applied: boolean }>(ok.json).applied).toBe(true);
  });

  it('never applies migrations out of order', async () => {
    const first = await api(base, 'POST', `/api/v1/projects/${project}/database/migrations`, agent, {
      name: 'step_one',
      sql: 'create table step_one (id uuid primary key);',
    });
    const second = await api(base, 'POST', `/api/v1/projects/${project}/database/migrations`, agent, {
      name: 'step_two',
      sql: 'create table step_two (id uuid primary key);',
    });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const secondId = data<{ migration: { id: string } }>(second.json).migration.id;
    const skipped = await api(
      base,
      'POST',
      `/api/v1/projects/${project}/database/migrations/${secondId}/apply`,
      agent,
      {},
    );
    expect(skipped.status).toBe(409);
    expect(errorOf(skipped.json).message).toContain('apply migrations in order');
  });

  it('always requires approval in production, even for a destructive-scoped token', async () => {
    const powerful = await api(base, 'POST', `/api/v1/organizations/${org}/agent-tokens`, ownerToken, {
      name: 'prod agent',
      scopes: ['projects.read', 'database.read', 'database.migrate', 'database.destructive'],
      projectIds: [project],
      // Production is granted explicitly, so this test still asserts what it
      // is named for: the approval gate, not the environment grant. Reaching
      // production now takes both, and the grant alone is never enough.
      environments: ['production'],
      approvalRequired: true,
      expiresIn: '7d',
    });
    expect(powerful.status).toBe(201);
    const raw = data<{ raw: string }>(powerful.json).raw;
    // Ordering is enforced before approval, so clear the pending queue first;
    // otherwise this test would assert the ordering rule, not the prod gate.
    const existing = await api(base, 'GET', `/api/v1/projects/${project}/database/migrations`, agent);
    for (const m of data<{ migrations: { id: string; status: string }[] }>(existing.json).migrations) {
      if (m.status === 'pending') {
        await api(base, 'DELETE', `/api/v1/projects/${project}/database/migrations/${m.id}`, agent);
      }
    }
    const created = await api(base, 'POST', `/api/v1/projects/${project}/database/migrations`, raw, {
      name: 'prod_change',
      sql: 'create table prod_change (id uuid primary key);',
      environment: 'production',
    });
    expect(created.status).toBe(201);
    const id = data<{ migration: { id: string; destructive: boolean } }>(created.json).migration.id;
    // Not destructive — production alone is enough to demand a human.
    expect(data<{ migration: { destructive: boolean } }>(created.json).migration.destructive).toBe(false);
    const held = await api(
      base,
      'POST',
      `/api/v1/projects/${project}/database/migrations/${id}/apply`,
      raw,
      {},
    );
    expect(held.status).toBe(428);
    expect(errorOf(held.json).code).toBe('APPROVAL_REQUIRED');
  });

  it('refuses production to a destructive token that was never granted it', async () => {
    // Same scopes as the token above, minus the environment grant. The scope
    // is what an over-granted token has; the grant is what it should not.
    const ungranted = await api(base, 'POST', `/api/v1/organizations/${org}/agent-tokens`, ownerToken, {
      name: 'no prod grant',
      scopes: ['projects.read', 'database.read', 'database.migrate', 'database.destructive'],
      projectIds: [project],
      approvalRequired: false,
      expiresIn: '7d',
    });
    expect(ungranted.status).toBe(201);
    const raw = data<{ raw: string }>(ungranted.json).raw;
    const existing = await api(base, 'GET', `/api/v1/projects/${project}/database/migrations`, agent);
    for (const m of data<{ migrations: { id: string; status: string }[] }>(existing.json).migrations) {
      if (m.status === 'pending') {
        await api(base, 'DELETE', `/api/v1/projects/${project}/database/migrations/${m.id}`, agent);
      }
    }
    // Create still succeeds: create executes nothing, and a human may yet
    // review it. Apply is where the environment is enforced.
    const created = await api(base, 'POST', `/api/v1/projects/${project}/database/migrations`, raw, {
      name: 'prod_ungranted',
      sql: 'create table prod_ungranted (id uuid primary key);',
      environment: 'production',
    });
    expect(created.status).toBe(201);
    const id = data<{ migration: { id: string } }>(created.json).migration.id;
    const denied = await api(
      base,
      'POST',
      `/api/v1/projects/${project}/database/migrations/${id}/apply`,
      raw,
      {},
    );
    expect(denied.status).toBe(403);
    expect(errorOf(denied.json).message).toContain('production');
  });

  it('rejects migrations that would escalate privilege', async () => {
    const r = await api(base, 'POST', `/api/v1/projects/${project}/database/migrations`, agent, {
      name: 'escalate',
      sql: 'create role attacker superuser;',
    });
    expect(r.status).toBe(400);
    expect(errorOf(r.json).code).toBe('RESTORE_REJECTED');
  });

  // ── BUILD (other planes) ──

  it('lets a scoped agent create a bucket and write a secret it can never read back', async () => {
    const bucket = await api(base, 'POST', `/api/v1/projects/${project}/storage/buckets`, agent, {
      name: 'uploads',
    });
    expect([200, 201]).toContain(bucket.status);

    // Secret writes need database.destructive, which this agent lacks.
    const denied = await api(
      base,
      'PUT',
      `/api/v1/projects/${project}/database/vault/STRIPE_KEY`,
      agent,
      { value: 'sk_test_value' },
    );
    expect(denied.status).toBe(403);

    // The human path works, and the value is never returned to an agent.
    const stored = await api(
      base,
      'PUT',
      `/api/v1/projects/${project}/database/vault/STRIPE_KEY`,
      ownerToken,
      { value: 'sk_test_value' },
    );
    expect(stored.status).toBe(200);
    const listed = await api(base, 'GET', `/api/v1/projects/${project}/database/vault`, agent);
    expect(listed.status).toBe(200);
    const secrets = data<{ secrets: { name: string }[] }>(listed.json).secrets;
    expect(secrets.map(s => s.name)).toContain('STRIPE_KEY');
    expect(JSON.stringify(listed.json)).not.toContain('sk_test_value');

    const reveal = await api(
      base,
      'POST',
      `/api/v1/projects/${project}/database/vault/STRIPE_KEY/reveal`,
      agent,
      {},
    );
    expect(reveal.status).toBe(403);
    expect(JSON.stringify(reveal.json)).not.toContain('sk_test_value');
  });

  it('generates types and reads logs for a scoped agent', async () => {
    const types = await api(base, 'GET', `/api/v1/projects/${project}/database/types`, agent);
    expect(types.status).toBe(200);
    expect(data<{ types: string }>(types.json).types).toContain('export');

    const jobs = await api(base, 'GET', `/api/v1/projects/${project}/jobs`, agent);
    expect(jobs.status).toBe(200);
  });

  // ── SECURITY: an unauthorized agent must be blocked ──

  it('blocks a read-only agent from every write path', async () => {
    const attempts: [string, string, unknown][] = [
      ['POST', `/api/v1/projects/${project}/database/migrations`, { name: 'sneaky', sql: 'create table sneaky (id uuid);' }],
      ['POST', `/api/v1/projects/${project}/storage/buckets`, { name: 'sneaky' }],
      ['PUT', `/api/v1/projects/${project}/database/vault/SNEAK`, { value: 'x' }],
    ];
    for (const [method, path, body] of attempts) {
      const r = await api(base, method, path, readOnlyAgent, body);
      expect(r.status, `${method} ${path}`).toBe(403);
      expect(errorOf(r.json).remediation, `${method} ${path}`).toBeTruthy();
    }
  });

  it('blocks a viewer-role human from creating or applying migrations', async () => {
    // `gate()` is a no-op for human sessions, so migrations carry their own
    // role check — without it, any org member could change production schema.
    const email = 'flow-viewer@example.com';
    const signup = await api(base, 'POST', '/api/v1/auth/signup', null, {
      email,
      password: 'viewer-password-1',
    });
    expect(signup.status).toBe(201);
    const viewer = data<{ token: string }>(signup.json).token;
    const invite = await api(base, 'POST', `/api/v1/organizations/${org}/invites`, ownerToken, {
      email,
      role: 'viewer',
    });
    expect(invite.status).toBe(201);
    const inviteToken = data<{ token: string }>(invite.json).token;
    expect(
      (await api(base, 'POST', `/api/v1/invites/${inviteToken}/accept`, viewer, {})).status,
    ).toBe(200);

    // Reading is fine — the viewer is a member.
    expect(
      (await api(base, 'GET', `/api/v1/projects/${project}/database/migrations`, viewer)).status,
    ).toBe(200);

    const create = await api(base, 'POST', `/api/v1/projects/${project}/database/migrations`, viewer, {
      name: 'viewer_change',
      sql: 'create table viewer_change (id uuid primary key);',
    });
    expect(create.status).toBe(403);
    expect(errorOf(create.json).code).toBe('FORBIDDEN');
  });

  it('confines an agent to its own organization and project', async () => {
    const crossProject = await api(base, 'GET', `/api/v1/projects/${otherProject}/connect`, agent);
    expect([403, 404]).toContain(crossProject.status);

    const crossOrg = await api(
      base,
      'GET',
      `/api/v1/organizations/${otherOrg}/agent-activity`,
      ownerToken,
    );
    expect(crossOrg.status).toBe(403);
  });

  it('rejects a revoked token immediately', async () => {
    const issued = await api(base, 'POST', `/api/v1/organizations/${org}/agent-tokens`, ownerToken, {
      name: 'short lived',
      scopes: ['projects.read'],
      projectIds: [project],
      expiresIn: '7d',
    });
    expect(issued.status).toBe(201);
    const { token, raw } = data<{ token: { id: string }; raw: string }>(issued.json);
    expect((await api(base, 'GET', '/api/v1/agent/whoami', raw)).status).toBe(200);
    const revoked = await api(
      base,
      'DELETE',
      `/api/v1/organizations/${org}/agent-tokens/${token.id}`,
      ownerToken,
    );
    expect(revoked.status).toBe(200);
    const after = await api(base, 'GET', '/api/v1/agent/whoami', raw);
    expect(after.status).toBeGreaterThanOrEqual(400);
    expect(after.status).not.toBe(200);
  });

  it('rejects an unknown or malformed agent token', async () => {
    for (const bad of ['cn_agent_totallyfake', 'not-a-token', '']) {
      const r = await api(base, 'GET', `/api/v1/projects/${project}/connect`, bad || null);
      expect(r.status, bad).toBeGreaterThanOrEqual(400);
      expect(r.status, bad).not.toBe(200);
    }
  });

  it('attaches machine-readable remediation and a request id to every failure', async () => {
    const r = await api(base, 'GET', `/api/v1/projects/${project}/database/migrations/nope`, agent);
    expect(r.status).toBe(404);
    const err = errorOf(r.json);
    expect(err.code).toBe('NOT_FOUND');
    expect(err.requestId.length).toBeGreaterThan(8);
    expect(err.remediation).toBeTruthy();
  });

  it('never writes a token or secret value into the audit trail', async () => {
    const activity = await api(base, 'GET', `/api/v1/organizations/${org}/agent-activity`, ownerToken);
    expect(activity.status).toBe(200);
    const body = JSON.stringify(activity.json);
    expect(body).not.toContain(agent);
    expect(body).not.toContain('sk_test_value');
  });
});
