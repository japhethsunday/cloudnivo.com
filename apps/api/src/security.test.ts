import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { signSession } from '@cloudnivo/auth';

const JWT_SECRET = 's'.repeat(48);
const WRONG_SECRET = 'w'.repeat(48);
const USER_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const USER_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

async function boot(): Promise<{ base: string; close: () => Promise<void> }> {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = 'postgres://u:p@localhost:5432/db';
  process.env.JWT_SECRET = JWT_SECRET;
  process.env.CORS_ORIGINS = 'http://localhost:3000';
  process.env.CACHE_DRIVER = 'memory';
  process.env.PROVISION_DRIVER = 'fake';
  process.env.STORAGE_DRIVER = 'local';
  process.env.STORAGE_LOCAL_DIR = await mkdtemp(join(tmpdir(), 'cn-api-security-'));
  const { start } = await import('./index.js');
  const { server, port } = await start(0);
  const srv = server as Server;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve, reject) => srv.close(e => (e ? reject(e) : resolve()))),
  };
}

async function tokenFor(sub: string, secret: string = JWT_SECRET): Promise<string> {
  return signSession({ sub, email: `${sub}@example.com` }, { jwtSecret: secret });
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

describe('phase 10 security regression (fake provider)', () => {
  let base = '';
  let close: () => Promise<void> = async () => {};
  let tokenA = '';
  let tokenB = '';
  let projectA = '';
  let fnSlug = '';

  beforeAll(async () => {
    const b = await boot();
    base = b.base;
    close = b.close;
    tokenA = await tokenFor(USER_A);
    tokenB = await tokenFor(USER_B);
    const org = await api(base, 'POST', '/api/v1/organizations', tokenA, {
      name: 'secorg',
      slug: 'secorg',
    });
    const orgId = data<{ organization: { id: string } }>(org.json).organization.id;
    const p = await api(base, 'POST', '/api/v1/projects', tokenA, {
      name: 'secshop',
      slug: 'secshop',
      organizationId: orgId,
    });
    const created = data<{ project: { id: string }; jobId: string }>(p.json);
    projectA = created.project.id;
    const deadline = Date.now() + 10_000;
    for (;;) {
      const j = await api(
        base,
        'GET',
        `/api/v1/projects/${projectA}/jobs/${created.jobId}`,
        tokenA,
      );
      const st = data<{ job: { status: string } }>(j.json).job.status;
      if (st === 'completed') break;
      if (st === 'failed' || Date.now() > deadline) throw new Error('provisioning failed');
      await new Promise(r => setTimeout(r, 50));
    }
    // One live function + one private bucket for the IDOR sweep.
    const fn = await api(base, 'POST', `/api/v1/projects/${projectA}/functions`, tokenA, {
      name: 'Sec Fn',
      slug: 'sec-fn',
    });
    fnSlug = data<{ function: { slug: string } }>(fn.json).function.slug;
    await api(base, 'POST', `/api/v1/projects/${projectA}/storage/buckets`, tokenA, {
      name: 'secbucket',
    });
  });

  afterAll(async () => {
    await close();
    const dir = process.env.STORAGE_LOCAL_DIR ?? '';
    if (dir.includes('cn-api-security-')) await rm(dir, { recursive: true, force: true });
  });

  it('rejects forged, malformed, and expired platform sessions (401, no leak)', async () => {
    const forged = await tokenFor(USER_A, WRONG_SECRET);
    for (const path of ['/api/v1/me', '/api/v1/organizations', `/api/v1/projects/${projectA}`]) {
      const r = await api(base, 'GET', path, forged);
      expect(r.status).toBe(401);
      expect(JSON.stringify(r.json)).not.toContain(JWT_SECRET);
    }
    const malformed = await api(base, 'GET', '/api/v1/me', 'not-a-jwt');
    expect(malformed.status).toBe(401);
    const missing = await api(base, 'GET', '/api/v1/me', null);
    expect(missing.status).toBe(401);
    const garbage = await api(base, 'GET', '/api/v1/me', null, undefined, {
      Authorization: 'Bearer',
    });
    expect(garbage.status).toBe(401);
  });

  it('rate-limits platform login brute force (429)', async () => {
    await api(base, 'POST', '/api/v1/auth/signup', null, {
      email: 'brute@example.com',
      password: 'long-enough-1',
    });
    let limited = false;
    for (let i = 0; i < 30; i += 1) {
      const r = await api(base, 'POST', '/api/v1/auth/login', null, {
        email: 'brute@example.com',
        password: 'wrong-password-1',
      });
      if (r.status === 429) {
        limited = true;
        break;
      }
      expect(r.status).toBe(401);
    }
    expect(limited).toBe(true);
  }, 30_000);

  it('denies every cross-project path with no existence oracle', async () => {
    const paths: [string, string][] = [
      ['GET', `/api/v1/projects/${projectA}`],
      ['GET', `/api/v1/projects/${projectA}/database`],
      ['GET', `/api/v1/projects/${projectA}/database/connection`],
      ['GET', `/api/v1/projects/${projectA}/jobs`],
      ['GET', `/api/v1/projects/${projectA}/storage/buckets`],
      ['GET', `/api/v1/projects/${projectA}/functions`],
      ['GET', `/api/v1/projects/${projectA}/functions/${fnSlug}`],
      ['GET', `/api/v1/projects/${projectA}/functions/${fnSlug}/env`],
      ['GET', `/api/v1/projects/${projectA}/functions/${fnSlug}/logs`],
      ['GET', `/api/v1/projects/${projectA}/realtime/stats`],
      ['GET', `/api/v1/projects/${projectA}/realtime/channels`],
      ['GET', `/api/v1/projects/${projectA}/ai/plans`],
      ['GET', `/api/v1/projects/${projectA}/ai/usage`],
    ];
    for (const [method, path] of paths) {
      const r = await api(base, method, path, tokenB);
      expect([401, 403, 404].includes(r.status), `${method} ${path} → ${r.status}`).toBe(true);
    }
    // Cross-project function invocation is denied, never executed.
    const invoked = await api(
      base,
      'POST',
      `/api/v1/projects/${projectA}/functions/${fnSlug}/invoke`,
      tokenB,
      {},
    );
    expect([401, 403, 404, 409].includes(invoked.status)).toBe(true);
    // Unknown IDs look identical to foreign IDs (no oracle).
    const ghost = '00000000-0000-4000-8000-000000000000';
    const a = await api(base, 'GET', `/api/v1/projects/${ghost}`, tokenA);
    const b = await api(base, 'GET', `/api/v1/projects/${projectA}/functions/no-such-fn`, tokenB);
    expect(a.status).toBe(404);
    expect([401, 403, 404].includes(b.status)).toBe(true);
  });

  it('neutralizes SQL editor stacking and identifier injection', async () => {
    const stacked = await api(base, 'POST', `/api/v1/projects/${projectA}/database/query`, tokenA, {
      sql: 'select 1; drop table users',
    });
    expect([400, 422].includes(stacked.status)).toBe(true);
    const quoted = await api(
      base,
      'GET',
      `/api/v1/projects/${projectA}/users%22%20OR%20%221%22=%221`,
      tokenA,
    );
    expect([400, 404].includes(quoted.status)).toBe(true);
    const aiSql = await api(base, 'POST', `/api/v1/projects/${projectA}/ai/plan`, tokenA, {
      prompt: 'Create table x"; DROP TABLE users; -- with columns.',
    });
    // Either rejected outright or planned without the hostile identifier.
    if (aiSql.status === 201) {
      expect(JSON.stringify(aiSql.json)).not.toContain('DROP TABLE users');
    } else {
      expect([400, 422].includes(aiSql.status)).toBe(true);
    }
  });

  it('blocks storage path traversal (never 200 with bytes)', async () => {
    for (const evil of ['..%2Fsecret', '..%2F..%2Fetc%2Fpasswd', '%2e%2e%2fsecret', 'a%00b']) {
      const r = await api(
        base,
        'GET',
        `/api/v1/projects/${projectA}/storage/buckets/secbucket/objects/${evil}`,
        tokenA,
      );
      expect([400, 404].includes(r.status), evil).toBe(true);
    }
    // Cross-project object reads fail closed.
    const orgB = await api(base, 'POST', '/api/v1/organizations', tokenB, {
      name: 'secorgb',
      slug: 'secorgb',
    });
    expect(orgB.status).toBe(201);
    const cross = await api(
      base,
      'GET',
      `/api/v1/projects/${projectA}/storage/buckets/secbucket/objects/nope.txt`,
      tokenB,
    );
    expect([401, 403, 404].includes(cross.status)).toBe(true);
  });

  it('contains hostile function source: build fails, never READY, never runs', async () => {
    const evil = await api(base, 'POST', `/api/v1/projects/${projectA}/functions`, tokenA, {
      name: 'Evil Fn',
      slug: 'evil-fn',
    });
    expect(evil.status).toBe(201);
    const d = await api(
      base,
      'POST',
      `/api/v1/projects/${projectA}/functions/evil-fn/deploy`,
      tokenA,
      {
        source: `const fs = require("fs"); module.exports.handler = async () => ({ body: fs.readFileSync("/etc/passwd", "utf8") });`,
      },
    );
    expect(d.status).toBe(202);
    const jobId = data<{ job: { id: string } }>(d.json).job.id;
    const deadline = Date.now() + 15_000;
    for (;;) {
      const g = await api(
        base,
        'GET',
        `/api/v1/projects/${projectA}/functions/evil-fn/deployments/${jobId}`,
        tokenA,
      );
      const job = data<{ deployment: { status: string } }>(g.json).deployment;
      if (job.status === 'failed') break;
      if (job.status === 'ready') throw new Error('hostile source reported READY');
      if (Date.now() > deadline) throw new Error('deploy timed out');
      await new Promise(r => setTimeout(r, 50));
    }
    const invoked = await api(
      base,
      'POST',
      `/api/v1/projects/${projectA}/functions/evil-fn/invoke`,
      tokenA,
      {},
    );
    expect(invoked.status).not.toBe(200);
    expect(JSON.stringify(invoked.json)).not.toContain('root:');
    // Oversized source is rejected at the boundary.
    const big = await api(
      base,
      'POST',
      `/api/v1/projects/${projectA}/functions/evil-fn/deploy`,
      tokenA,
      {
        source: `x${'y'.repeat(6 * 1024 * 1024)}`,
      },
    );
    expect(big.status).toBe(413);
  });
});
