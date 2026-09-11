import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { signSession } from '@cloudnivo/auth';

// File-level isolation: this low budget applies only to this suite's server.
process.env.AGENT_RATE_MAX = '3';

const JWT_SECRET = 'h'.repeat(48);
const USER_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';

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

async function postJson(url: string, token: string | null, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return (await res.json()) as Record<string, unknown>;
}

describe('phase 13 agent rate limiting', () => {
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

  it('allows a burst then answers 429 per token', async () => {
    const owner = await signSession(
      { sub: USER_A, email: `${USER_A}@example.com` },
      { jwtSecret: JWT_SECRET },
    );
    const org = await postJson(`${base}/api/v1/organizations`, owner, { name: 'rlorg', slug: 'rlorg' });
    const orgId = (org['data'] as { organization: { id: string } }).organization.id;
    const created = await postJson(`${base}/api/v1/organizations/${orgId}/agent-tokens`, owner, {
      name: 'limited',
      scopes: ['projects.read'],
      projectIds: [],
    });
    const raw = (created['data'] as { raw: string }).raw as string;
    const statuses: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      statuses.push(
        (
          await fetch(`${base}/api/v1/projects`, {
            headers: { Authorization: `Bearer ${raw}` },
          })
        ).status,
      );
    }
    expect(statuses).toEqual([200, 200, 200, 429]);
    // A different token has its own budget.
    const other = await postJson(`${base}/api/v1/organizations/${orgId}/agent-tokens`, owner, {
      name: 'other',
      scopes: ['projects.read'],
      projectIds: [],
    });
    const raw2 = (other['data'] as { raw: string }).raw as string;
    expect(
      (
        await fetch(`${base}/api/v1/projects`, {
          headers: { Authorization: `Bearer ${raw2}` },
        })
      ).status,
    ).toBe(200);
  });
});
