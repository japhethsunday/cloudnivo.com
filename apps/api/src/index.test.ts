import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { signSession } from '@cloudnivo/auth';

const JWT_SECRET = 't'.repeat(48);

async function boot(): Promise<{ base: string; close: () => Promise<void> }> {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = 'postgres://u:p@localhost:5432/db';
  process.env.JWT_SECRET = JWT_SECRET;
  process.env.CORS_ORIGINS = 'http://localhost:3000';
  process.env.CACHE_DRIVER = 'memory';
  const { start } = await import('./index.js');
  const { server, port } = await start(0);
  const srv = server as Server;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve, reject) => srv.close(e => (e ? reject(e) : resolve()))),
  };
}

describe('apps/api v1', () => {
  let base = '';
  let close: () => Promise<void> = async () => {};
  beforeAll(async () => {
    const b = await boot();
    base = b.base;
    close = b.close;
  });
  afterAll(async () => {
    await close();
  });

  it('health returns versioned envelope + security headers', async () => {
    const res = await fetch(`${base}/api/v1/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('x-request-id')).toBeTruthy();
    const json = (await res.json()) as { data: { status: string } };
    expect(json.data.status).toBe('ok');
  });

  it('rejects unauthenticated project access (auth boundary)', async () => {
    const res = await fetch(`${base}/api/v1/projects`);
    expect(res.status).toBe(401);
    const json = (await res.json()) as { error: { code: string; requestId: string } };
    expect(json.error.code).toBe('UNAUTHORIZED');
    expect(json.error.requestId).toBeTruthy();
  });

  it('validates project input (400, no leak)', async () => {
    const token = await signSession(
      { sub: '123e4567-e89b-12d3-a456-426614174000', email: 't@example.com' },
      { jwtSecret: JWT_SECRET },
    );
    const res = await fetch(`${base}/api/v1/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: 'x', slug: 'BAD SLUG', organizationId: 'nope' }),
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 404 envelope for unknown routes', async () => {
    const res = await fetch(`${base}/api/v1/nope`);
    expect(res.status).toBe(404);
  });
});
