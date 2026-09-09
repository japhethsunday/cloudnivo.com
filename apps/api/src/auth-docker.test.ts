import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { signSession } from '@cloudnivo/auth';

const execFileAsync = promisify(execFile);
const runDocker = process.env.DOCKER_TESTS === '1';

// Real end-to-end on managed-by-CloudNivo Postgres:
// provision → auth schema → signup/login → RLS-scoped data → cleanup.
// Needs Docker + image pull; runs only with DOCKER_TESTS=1.
describe.skipIf(!runDocker)('phase 4 auth on real postgres', () => {
  let base = '';
  let close: () => Promise<void> = async () => {};
  let token = '';
  let projectId = '';

  beforeAll(async () => {
    try {
      await execFileAsync('docker', ['version', '--format', '{{.Server.Version}}'], {
        timeout: 10_000,
      });
    } catch {
      console.warn('Docker not present; skipping live auth assertions');
      return;
    }
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL = 'postgres://u:p@localhost:5432/db';
    process.env.JWT_SECRET = 'd'.repeat(48);
    process.env.CORS_ORIGINS = 'http://localhost:3000';
    process.env.CACHE_DRIVER = 'memory';
    process.env.PROVISION_DRIVER = 'docker';
    process.env.PROVISION_BASE_PORT = '15700';
    const { start } = await import('./index.js');
    const { server, port } = await start(0);
    const srv = server as Server;
    base = `http://127.0.0.1:${port}`;
    close = () => new Promise((resolve, reject) => srv.close(e => (e ? reject(e) : resolve())));
    token = await signSession(
      { sub: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', email: 'a@example.com' },
      { jwtSecret: 'd'.repeat(48) },
    );
  }, 60_000);

  afterAll(async () => {
    await close();
    process.env.PROVISION_DRIVER = 'fake';
  });

  async function api(method: string, path: string, body?: unknown, bearer?: string) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }

  it('provisions, registers a user, and enforces ownership for real', async () => {
    if (!base) return;
    const org = await api(
      'POST',
      '/api/v1/organizations',
      { name: 'Live', slug: 'livedock' },
      token,
    );
    const orgId = (org.json['data'] as { organization: { id: string } }).organization.id;
    const p = await api(
      'POST',
      '/api/v1/projects',
      { name: 'liveauth', slug: 'liveauth', organizationId: orgId },
      token,
    );
    expect(p.status).toBe(202);
    const { project, jobId } = p.json['data'] as { project: { id: string }; jobId: string };
    projectId = project.id;
    for (let i = 0; i < 120; i += 1) {
      const j = await api('GET', `/api/v1/projects/${projectId}/jobs/${jobId}`, undefined, token);
      const st = (j.json['data'] as { job: { status: string } }).job.status;
      if (st === 'completed') break;
      if (st === 'failed' || i === 119) throw new Error('provisioning failed');
      await new Promise(r => setTimeout(r, 2000));
    }
    const A = `/api/v1/projects/${projectId}/auth`;
    const su = await api('POST', `${A}/signup`, {
      email: 'live@example.com',
      password: 'live-password-1',
    });
    expect(su.status).toBe(201);
    const login = await api('POST', `${A}/token`, {
      email: 'live@example.com',
      password: 'live-password-1',
    });
    expect(login.status).toBe(200);
    const access = (login.json['data'] as { tokens: { accessToken: string } }).tokens.accessToken;

    // Customer table with owner column, exercised through the real engine.
    const dbToken = token;
    const created = await api(
      'POST',
      `/api/v1/projects/${projectId}/database/query`,
      { sql: 'CREATE TABLE notes (id uuid PRIMARY KEY, user_id uuid NOT NULL, body text)' },
      dbToken,
    );
    expect(created.status).toBe(200);
    const ins = await api(
      'POST',
      `/api/v1/projects/${projectId}/notes`,
      { id: '11111111-1111-4111-8111-111111111111', body: 'hi' },
      access,
    );
    expect(ins.status).toBe(201);
    expect(
      ((ins.json['data'] as { row: { user_id: string } }).row.user_id ?? '').length,
    ).toBeGreaterThan(0);
    const list = await api('GET', `/api/v1/projects/${projectId}/notes`, undefined, access);
    expect((list.json['data'] as { rows: unknown[] }).rows).toHaveLength(1);

    await api('DELETE', `/api/v1/projects/${projectId}`, undefined, token);
  }, 300_000);
});
