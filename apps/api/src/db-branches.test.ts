import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { signSession } from '@cloudnivo/auth';

const JWT_SECRET = 'b'.repeat(48);
const USER_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';

async function boot(): Promise<{ base: string; close: () => Promise<void> }> {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = 'postgres://u:p@localhost:5432/db';
  process.env.JWT_SECRET = JWT_SECRET;
  process.env.CORS_ORIGINS = 'http://localhost:3000';
  process.env.CACHE_DRIVER = 'memory';
  process.env.PROVISION_DRIVER = 'fake';
  process.env.VAULT_KEY = 'v'.repeat(40);
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
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

function data<T>(json: Record<string, unknown>): T {
  return (json['data'] ?? json) as T;
}

describe('database branches + power tools', () => {
  let base = '';
  let close: () => Promise<void> = async () => {};
  let token = '';
  let projectId = '';

  beforeAll(async () => {
    const b = await boot();
    base = b.base;
    close = b.close;
    token = await signSession({ sub: USER_A, email: 'br@example.com' }, { jwtSecret: JWT_SECRET });
    const org = await api(base, 'POST', '/api/v1/organizations', token, {
      name: 'Branch Org',
      slug: 'branchorg',
    });
    const orgId = data<{ organization: { id: string } }>(org.json).organization.id;
    const p = await api(base, 'POST', '/api/v1/projects', token, {
      name: 'Branch Shop',
      slug: 'branchshop',
      organizationId: orgId,
    });
    projectId = data<{ project: { id: string } }>(p.json).project.id;
  });
  afterAll(async () => {
    await close();
  });

  const db = (): string => `/api/v1/projects/${projectId}/database`;

  it('creates, lists, diffs, resets, and deletes branches', async () => {
    const created = await api(base, 'POST', `${db()}/branches`, token, { name: 'feature-a' });
    expect(created.status).toBe(201);
    const branch = data<{ branch: { id: string; name: string; status: string; dbPassword: string } }>(
      created.json,
    ).branch;
    expect(branch.name).toBe('feature-a');
    expect(branch.status).toBe('ready');
    expect(branch.dbPassword).toBe('••••••••');

    expect((await api(base, 'POST', `${db()}/branches`, token, { name: 'feature-a' })).status).toBe(502);
    expect((await api(base, 'POST', `${db()}/branches`, token, { name: 'main' })).status).toBe(502);

    const listed = await api(base, 'GET', `${db()}/branches`, token);
    expect(data<{ branches: { id: string }[] }>(listed.json).branches.map(b => b.id)).toContain(branch.id);

    const diff = await api(base, 'POST', `${db()}/diff`, token, { base: 'main', compare: branch.id });
    expect(diff.status).toBe(200);
    expect(data<{ diff: { addedTables: unknown[] } }>(diff.json).diff).toBeDefined();

    const conn = await api(base, 'GET', `${db()}/branches/${branch.id}/connection`, token);
    expect(conn.status).toBe(200);
    expect(data<{ password: string }>(conn.json).password).toBe('••••••••');

    const reset = await api(base, 'POST', `${db()}/branches/${branch.id}/reset`, token, {});
    expect(reset.status).toBe(200);

    expect((await api(base, 'DELETE', `${db()}/branches/${branch.id}`, token)).status).toBe(200);
    expect((await api(base, 'GET', `${db()}/branches/${branch.id}`, token)).status).toBe(404);
  });

  it('serves advisors, replication, routines, types, and extensions', async () => {
    expect((await api(base, 'GET', `${db()}/advisors`, token)).status).toBe(200);
    expect((await api(base, 'GET', `${db()}/replication`, token)).status).toBe(200);
    expect((await api(base, 'GET', `${db()}/routines`, token)).status).toBe(200);
    const types = await api(base, 'GET', `${db()}/types`, token);
    expect(types.status).toBe(200);
    expect(data<{ types: string }>(types.json).types).toContain('export interface');
    expect((await api(base, 'POST', `${db()}/extensions`, token, { name: 'nope-evil' })).status).toBe(400);
    expect((await api(base, 'POST', `${db()}/extensions`, token, { name: 'pg_trgm' })).status).toBe(201);
  });

  it('restores guarded SQL and rejects privileged scope', async () => {
    const good = await api(base, 'POST', `${db()}/restore`, token, {
      sql: 'CREATE TABLE r1 (a text); INSERT INTO r1 VALUES (1);',
    });
    expect(good.status).toBe(200);
    expect(data<{ restored: boolean; executed: number }>(good.json)).toMatchObject({
      restored: true,
      executed: 2,
    });
    expect((await api(base, 'POST', `${db()}/restore`, token, { sql: 'CREATE ROLE x;' })).status).toBe(400);
  });

  it('simulates RLS as explicit caller contexts without executing', async () => {
    const userId = '11111111-1111-4111-8111-111111111111';
    const sim = await api(base, 'POST', `${db()}/rls-simulate`, token, {
      sql: 'SELECT * FROM users',
      userId,
      role: 'authenticated',
    });
    expect(sim.status).toBe(200);
    expect(data<{ simulation: { settings: { role: string } } }>(sim.json).simulation.settings.role).toBe(
      'authenticated',
    );
    expect((await api(base, 'POST', `${db()}/rls-simulate`, token, {
      sql: 'DROP TABLE users',
      userId,
      role: 'authenticated',
    })).status).toBe(400);
    expect((await api(base, 'POST', `${db()}/rls-simulate`, token, {
      sql: 'SELECT 1',
      userId: 'not-a-uuid',
      role: 'authenticated',
    })).status).toBe(400);
  });

  it('rejects postgres imports with unsafe sources before infra', async () => {
    expect((await api(base, 'POST', `${db()}/import`, token, { sourceUrl: 'mysql://h/db' })).status).toBe(400);
    expect((await api(base, 'POST', `${db()}/import`, token, { sourceUrl: 'not-a-url-at-all' })).status).toBe(400);
  });

  it('stores vault secrets write-only with audited reveal', async () => {
    expect((await api(base, 'PUT', `${db()}/vault/api-key`, token, { value: 'shh-1' })).status).toBe(200);
    const listed = await api(base, 'GET', `${db()}/vault`, token);
    expect(data<{ secrets: { name: string }[] }>(listed.json).secrets.map(s => s.name)).toContain('api-key');
    expect(JSON.stringify(listed.json)).not.toContain('shh-1');
    const revealed = await api(base, 'POST', `${db()}/vault/api-key/reveal`, token, {});
    expect(data<{ value: string }>(revealed.json).value).toBe('shh-1');
    expect((await api(base, 'DELETE', `${db()}/vault/api-key`, token)).status).toBe(200);
    expect((await api(base, 'POST', `${db()}/vault/api-key/reveal`, token, {})).status).toBe(404);
  });

  it('manages preview environments bound to auto-branches', async () => {
    const env = await api(base, 'POST', `${db()}/environments`, token, {
      name: 'Preview',
      slug: 'preview',
      preview: true,
    });
    expect(env.status).toBe(201);
    const created = data<{ environment: { id: string; branchId: string | null; isPreview: boolean } }>(env.json).environment;
    expect(created.isPreview).toBe(true);
    expect(created.branchId).toBeTruthy();
    const listed = await api(base, 'GET', `${db()}/environments`, token);
    expect(data<{ environments: unknown[] }>(listed.json).environments.length).toBeGreaterThan(0);
    expect(
      (await api(base, 'DELETE', `${db()}/environments/${created.id}`, token)).status,
    ).toBe(200);
  });
});
